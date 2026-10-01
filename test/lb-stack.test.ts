import * as fs from 'node:fs';
import * as path from 'node:path';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { LbStack, lbStackPropsFromContext, type LbStackConfig } from '../lib/lb-stack';

// Use the same context (feature flags + defaults) as `cdk synth`.
const cdkContext = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'cdk.json'), 'utf8'),
).context as Record<string, unknown>;

function synth(overrides: Partial<LbStackConfig> = {}): Template {
  const app = new App({ context: cdkContext });
  const stack = new LbStack(app, 'TestStack', {
    ...lbStackPropsFromContext(app.node),
    ...overrides,
  });
  return Template.fromStack(stack);
}

/** Logical ID of the single security group whose description starts with `prefix`. */
function sgId(t: Template, prefix: string): string {
  const sgs = t.findResources('AWS::EC2::SecurityGroup', {
    Properties: { GroupDescription: Match.stringLikeRegexp(`^${prefix}`) },
  });
  const ids = Object.keys(sgs);
  expect(ids).toHaveLength(1);
  return ids[0];
}

describe('LbStack (default, TLS on)', () => {
  let t: Template;
  beforeAll(() => {
    t = synth();
  });

  it('creates the public hosted zone, retained on delete', () => {
    t.resourceCountIs('AWS::Route53::HostedZone', 1);
    t.hasResource('AWS::Route53::HostedZone', {
      Properties: { Name: 'auth.example.com.' },
      DeletionPolicy: 'Retain',
    });
  });

  it('creates a DNS-validated certificate', () => {
    t.resourceCountIs('AWS::CertificateManager::Certificate', 1);
    t.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'auth.example.com',
      ValidationMethod: 'DNS',
    });
  });

  it('uses one NAT gateway across 2 AZs', () => {
    t.resourceCountIs('AWS::EC2::NatGateway', 1);
    t.resourceCountIs('AWS::EC2::Subnet', 6);
  });

  it('creates an internet-facing ALB with HTTPS and an HTTP->HTTPS redirect', () => {
    t.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internet-facing',
    });
    t.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 2);
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Protocol: 'HTTPS',
      Certificates: Match.anyValue(),
    });
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      DefaultActions: [
        Match.objectLike({
          Type: 'redirect',
          RedirectConfig: Match.objectLike({ Protocol: 'HTTPS', Port: '443' }),
        }),
      ],
    });
  });

  it('creates the three diagram instances with IMDSv2 and encrypted gp3 root', () => {
    const instances = t.findResources('AWS::EC2::Instance');
    expect(Object.keys(instances)).toHaveLength(3);
    const names = Object.values(instances).map(
      (r) => (r.Properties.Tags as { Key: string; Value: string }[]).find((tag) => tag.Key === 'Name')
        ?.Value,
    );
    expect(names.sort()).toEqual(['one', 'three', 'two']);
    t.allResourcesProperties('AWS::EC2::Instance', {
      BlockDeviceMappings: [
        Match.objectLike({ Ebs: Match.objectLike({ Encrypted: true, VolumeType: 'gp3' }) }),
      ],
    });
    t.resourceCountIs('AWS::EC2::LaunchTemplate', 3);
    t.allResourcesProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: { MetadataOptions: { HttpTokens: 'required' } },
    });
  });

  it('resolves the AMI from the Debian 13 arm64 SSM parameter', () => {
    const params = t.toJSON().Parameters as Record<string, { Default?: string }>;
    expect(Object.values(params).map((p) => p.Default)).toContain(
      '/aws/service/debian/release/13/latest/arm64',
    );
  });

  it('registers all instances in one target group with /health checks', () => {
    t.resourceCountIs('AWS::ElasticLoadBalancingV2::TargetGroup', 1);
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      Port: 80,
      Protocol: 'HTTP',
      HealthCheckPath: '/health',
      Targets: Match.arrayWith([Match.objectLike({ Port: 80 })]),
    });
    const tg = Object.values(t.findResources('AWS::ElasticLoadBalancingV2::TargetGroup'))[0];
    expect(tg.Properties.Targets).toHaveLength(3);
  });

  it('creates Postgres 18 single-AZ primary and one read replica', () => {
    t.resourceCountIs('AWS::RDS::DBInstance', 2);
    t.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      EngineVersion: Match.stringLikeRegexp('^18'),
      MultiAZ: false,
      DBName: 'my_db',
      DBInstanceClass: 'db.t4g.micro',
      StorageType: 'gp3',
      StorageEncrypted: true,
      PubliclyAccessible: false,
    });
    t.hasResourceProperties('AWS::RDS::DBInstance', {
      SourceDBInstanceIdentifier: Match.anyValue(),
      DBInstanceClass: 'db.t4g.micro',
    });
    t.hasResource('AWS::RDS::DBInstance', {
      Properties: { Engine: 'postgres' },
      DeletionPolicy: 'Snapshot',
    });
  });

  it('only allows 5432 from the web SG and 80 on web only from the ALB SG', () => {
    const albSg = sgId(t, 'ALB');
    const webSg = sgId(t, 'Web instances');
    const dbSg = sgId(t, 'Postgres');

    const ingress = Object.values(t.findResources('AWS::EC2::SecurityGroupIngress')).map(
      (r) => r.Properties,
    );
    const into = (sg: string) =>
      ingress.filter((p) => JSON.stringify(p.GroupId).includes(sg));

    const dbRules = into(dbSg);
    expect(dbRules).toHaveLength(1);
    expect(dbRules[0]).toMatchObject({ FromPort: 5432, ToPort: 5432 });
    expect(JSON.stringify(dbRules[0].SourceSecurityGroupId)).toContain(webSg);

    const webRules = into(webSg);
    expect(webRules).toHaveLength(1);
    expect(webRules[0]).toMatchObject({ FromPort: 80, ToPort: 80 });
    expect(JSON.stringify(webRules[0].SourceSecurityGroupId)).toContain(albSg);

    // No inline CIDR ingress on web/db SGs.
    for (const id of [webSg, dbSg]) {
      const sg = t.findResources('AWS::EC2::SecurityGroup')[id];
      expect(sg.Properties.SecurityGroupIngress).toBeUndefined();
    }
  });

  it('lets the instance role read the DB secret and use SSM', () => {
    t.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['secretsmanager:GetSecretValue']),
            Effect: 'Allow',
          }),
        ]),
      },
    });
    t.hasResourceProperties('AWS::IAM::Role', {
      ManagedPolicyArns: Match.arrayWith([
        Match.objectLike({
          'Fn::Join': Match.arrayWith([
            Match.arrayWith([Match.stringLikeRegexp('AmazonSSMManagedInstanceCore')]),
          ]),
        }),
      ]),
    });
  });

  it('aliases the zone apex to the ALB', () => {
    t.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'auth.example.com.',
      Type: 'A',
      AliasTarget: Match.anyValue(),
    });
  });

  it('does not write the DB password into user data', () => {
    const json = JSON.stringify(t.findResources('AWS::EC2::Instance'));
    expect(json).toContain('DB_SECRET_ARN=');
    expect(json).not.toMatch(/DB_PASSWORD|resolve:secretsmanager/);
  });
});

describe('LbStack (enableTls=false)', () => {
  it('has no certificate and a single forwarding HTTP listener', () => {
    const t = synth({ enableTls: false });
    t.resourceCountIs('AWS::CertificateManager::Certificate', 0);
    t.resourceCountIs('AWS::ElasticLoadBalancingV2::Listener', 1);
    t.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      Protocol: 'HTTP',
      DefaultActions: [Match.objectLike({ Type: 'forward' })],
    });
  });
});

describe('LbStack (instanceCount override)', () => {
  it('names extra instances web-N', () => {
    const t = synth({ instanceCount: 4 });
    const names = Object.values(t.findResources('AWS::EC2::Instance')).map(
      (r) => (r.Properties.Tags as { Key: string; Value: string }[]).find((tag) => tag.Key === 'Name')
        ?.Value,
    );
    expect(names).toContain('web-4');
  });

  it('rejects instanceCount 0', () => {
    expect(() => synth({ instanceCount: 0 })).toThrow(/at least 1/);
  });
});
