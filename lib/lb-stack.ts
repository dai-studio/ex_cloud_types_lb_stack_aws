import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  Aws,
  CfnOutput,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as elbv2Targets from 'aws-cdk-lib/aws-elasticloadbalancingv2-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import type { Construct, Node } from 'constructs';

/** Instance names from the diagram; extra instances fall back to `web-N`. */
const DIAGRAM_INSTANCE_NAMES = ['one', 'two', 'three'];

/** Public SSM parameter maintained by the Debian cloud team. */
const DEBIAN_13_ARM64_AMI_PARAM = '/aws/service/debian/release/13/latest/arm64';

export interface LbStackConfig {
  /** Public hosted zone created by this stack; also the site hostname. */
  readonly domainName: string;
  readonly instanceType: string;
  /** RDS class without the `db.` prefix, e.g. `t4g.micro`. */
  readonly dbInstanceClass: string;
  readonly dbAllocatedStorage: number;
  readonly instanceCount: number;
  readonly natGateways: number;
  /** When false: no ACM cert, ALB serves HTTP only (bootstrap before NS delegation). */
  readonly enableTls: boolean;
  /** Override the AMI (tests / non-Debian experiments). */
  readonly machineImage?: ec2.IMachineImage;
}

export type LbStackProps = StackProps & LbStackConfig;

export const DEFAULT_CONFIG: LbStackConfig = {
  domainName: 'auth.example.com',
  instanceType: 't4g.small',
  dbInstanceClass: 't4g.micro',
  dbAllocatedStorage: 20,
  instanceCount: 3,
  natGateways: 1,
  enableTls: true,
};

/** Read stack config from CDK context (`cdk.json` or `-c key=value`). */
export function lbStackPropsFromContext(node: Node): LbStackConfig {
  const str = (key: keyof LbStackConfig, def: string): string => {
    const v = node.tryGetContext(key);
    return v === undefined || v === null || v === '' ? def : String(v);
  };
  const num = (key: keyof LbStackConfig, def: number): number => {
    const raw = str(key, String(def));
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`Context '${key}' must be a non-negative integer, got '${raw}'`);
    }
    return n;
  };
  const bool = (key: keyof LbStackConfig, def: boolean): boolean => {
    const raw = str(key, String(def)).toLowerCase();
    if (raw !== 'true' && raw !== 'false') {
      throw new Error(`Context '${key}' must be true or false, got '${raw}'`);
    }
    return raw === 'true';
  };

  return {
    domainName: str('domainName', DEFAULT_CONFIG.domainName),
    instanceType: str('instanceType', DEFAULT_CONFIG.instanceType),
    dbInstanceClass: str('dbInstanceClass', DEFAULT_CONFIG.dbInstanceClass),
    dbAllocatedStorage: num('dbAllocatedStorage', DEFAULT_CONFIG.dbAllocatedStorage),
    instanceCount: num('instanceCount', DEFAULT_CONFIG.instanceCount),
    natGateways: num('natGateways', DEFAULT_CONFIG.natGateways),
    enableTls: bool('enableTls', DEFAULT_CONFIG.enableTls),
  };
}

export class LbStack extends Stack {
  constructor(scope: Construct, id: string, props: LbStackProps) {
    super(scope, id, props);

    if (props.instanceCount < 1) {
      throw new Error('instanceCount must be at least 1');
    }

    // --- Network -----------------------------------------------------------
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: props.natGateways,
      subnetConfiguration: [
        { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'Isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const albSg = new ec2.SecurityGroup(this, 'AlbSg', {
      vpc,
      description: 'ALB: public HTTP/HTTPS',
      allowAllOutbound: false,
    });
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP from internet');
    if (props.enableTls) {
      albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS from internet');
    }

    const webSg = new ec2.SecurityGroup(this, 'WebSg', {
      vpc,
      description: 'Web instances: HTTP from ALB only',
      allowAllOutbound: true, // apt, SSM, Secrets Manager via NAT
    });
    webSg.addIngressRule(albSg, ec2.Port.tcp(80), 'HTTP from ALB');
    albSg.addEgressRule(webSg, ec2.Port.tcp(80), 'ALB to web instances');

    const dbSg = new ec2.SecurityGroup(this, 'DbSg', {
      vpc,
      description: 'Postgres: 5432 from web instances only',
      allowAllOutbound: false,
    });
    dbSg.addIngressRule(webSg, ec2.Port.tcp(5432), 'Postgres from web instances');

    // --- DNS + TLS -------------------------------------------------------
    const zone = new route53.PublicHostedZone(this, 'Zone', {
      zoneName: props.domainName,
    });
    zone.applyRemovalPolicy(RemovalPolicy.RETAIN);

    const certificate = props.enableTls
      ? new acm.Certificate(this, 'Certificate', {
          domainName: props.domainName,
          validation: acm.CertificateValidation.fromDns(zone),
        })
      : undefined;

    // --- Database: my_db (Postgres 18, single-AZ, 1 read replica) --------
    const dbInstanceType = new ec2.InstanceType(props.dbInstanceClass);
    const db = new rds.DatabaseInstance(this, 'Db', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_18,
      }),
      instanceType: dbInstanceType,
      credentials: rds.Credentials.fromGeneratedSecret('postgres'),
      databaseName: 'my_db',
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      multiAz: false,
      allocatedStorage: props.dbAllocatedStorage,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      backupRetention: Duration.days(1), // read replicas require backups > 0
      deletionProtection: false,
      removalPolicy: RemovalPolicy.SNAPSHOT,
      publiclyAccessible: false,
    });

    const replica = new rds.DatabaseInstanceReadReplica(this, 'DbReplica', {
      sourceDatabaseInstance: db,
      instanceType: dbInstanceType,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSg],
      // Encryption is inherited from the (encrypted) source instance.
      deletionProtection: false,
      removalPolicy: RemovalPolicy.DESTROY, // replicas cannot be snapshotted on delete
      publiclyAccessible: false,
    });

    const dbSecret = db.secret;
    if (!dbSecret) {
      throw new Error('Expected generated DB secret');
    }

    // --- Web instances: one, two, three ----------------------------------
    const role = new iam.Role(this, 'WebRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });
    dbSecret.grantRead(role);

    const machineImage =
      props.machineImage ?? ec2.MachineImage.fromSsmParameter(DEBIAN_13_ARM64_AMI_PARAM);
    const bootstrapScript = fs.readFileSync(
      path.join(__dirname, 'user-data', 'nginx.sh'),
      'utf8',
    );

    const privateSubnets = vpc.privateSubnets;
    const instances: ec2.Instance[] = [];
    for (let i = 0; i < props.instanceCount; i++) {
      const name = DIAGRAM_INSTANCE_NAMES[i] ?? `web-${i + 1}`;

      const userData = ec2.UserData.forLinux();
      userData.addCommands(
        'set -euxo pipefail',
        `export INSTANCE_NAME='${name}'`,
        `export AWS_REGION='${Aws.REGION}'`,
        'mkdir -p /etc/dai',
        // Non-secret connection info only; the password stays in Secrets Manager.
        'cat > /etc/dai/db.env <<EOF',
        `DB_HOST=${db.dbInstanceEndpointAddress}`,
        `DB_PORT=${db.dbInstanceEndpointPort}`,
        `DB_READ_HOST=${replica.dbInstanceEndpointAddress}`,
        'DB_NAME=my_db',
        `DB_SECRET_ARN=${dbSecret.secretArn}`,
        `AWS_REGION=${Aws.REGION}`,
        'EOF',
        'chmod 0644 /etc/dai/db.env',
        bootstrapScript,
      );

      const instance = new ec2.Instance(this, `Instance-${name}`, {
        instanceName: name,
        vpc,
        vpcSubnets: { subnets: [privateSubnets[i % privateSubnets.length]] },
        instanceType: new ec2.InstanceType(props.instanceType),
        machineImage,
        securityGroup: webSg,
        role,
        userData,
        userDataCausesReplacement: true,
        requireImdsv2: true,
        blockDevices: [
          {
            deviceName: '/dev/xvda', // Debian AMI root device
            volume: ec2.BlockDeviceVolume.ebs(8, {
              volumeType: ec2.EbsDeviceVolumeType.GP3,
              encrypted: true,
            }),
          },
        ],
      });
      instances.push(instance);
    }

    // --- Load balancer: lb ----------------------------------------------
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: albSg,
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'WebTargets', {
      vpc,
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.INSTANCE,
      targets: instances.map((inst) => new elbv2Targets.InstanceTarget(inst, 80)),
      healthCheck: {
        path: '/health',
        healthyHttpCodes: '200',
        interval: Duration.seconds(15),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      deregistrationDelay: Duration.seconds(30),
    });

    if (certificate) {
      alb.addListener('Https', {
        port: 443,
        protocol: elbv2.ApplicationProtocol.HTTPS,
        certificates: [certificate],
        sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
        defaultTargetGroups: [targetGroup],
        open: false, // ingress managed explicitly on albSg
      });
      alb.addListener('Http', {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        defaultAction: elbv2.ListenerAction.redirect({
          protocol: 'HTTPS',
          port: '443',
          permanent: true,
        }),
        open: false,
      });
    } else {
      alb.addListener('Http', {
        port: 80,
        protocol: elbv2.ApplicationProtocol.HTTP,
        defaultTargetGroups: [targetGroup],
        open: false,
      });
    }

    // ALB is IPv4-only, so an A alias at the zone apex is sufficient.
    new route53.ARecord(this, 'AliasA', {
      zone,
      target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(alb)),
    });

    // --- Outputs ----------------------------------------------------------
    new CfnOutput(this, 'NameServers', {
      description: `Delegate ${props.domainName} to these in the parent zone (NS record)`,
      value: Fn.join(',', zone.hostedZoneNameServers ?? []),
    });
    new CfnOutput(this, 'HostedZoneId', { value: zone.hostedZoneId });
    new CfnOutput(this, 'SiteUrl', {
      value: `${props.enableTls ? 'https' : 'http'}://${props.domainName}`,
    });
    new CfnOutput(this, 'AlbDnsName', { value: alb.loadBalancerDnsName });
    new CfnOutput(this, 'DbEndpoint', { value: db.dbInstanceEndpointAddress });
    new CfnOutput(this, 'DbReplicaEndpoint', { value: replica.dbInstanceEndpointAddress });
    new CfnOutput(this, 'DbSecretArn', { value: dbSecret.secretArn });
    new CfnOutput(this, 'InstanceIds', {
      value: Fn.join(',', instances.map((i) => i.instanceId)),
    });
  }
}
