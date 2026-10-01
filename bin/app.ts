#!/usr/bin/env node
import { App, Tags } from 'aws-cdk-lib';
import { LbStack, lbStackPropsFromContext } from '../lib/lb-stack';

const app = new App();

const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION;

new LbStack(app, 'LbStack', {
  description: 'Load balanced service on AWS (DAI Studio diagram 31191b2f)',
  env: account && region ? { account, region } : undefined,
  ...lbStackPropsFromContext(app.node),
});

Tags.of(app).add('project', 'lb-stack');
Tags.of(app).add('source', 'dai.studio/31191b2f');
