#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ImageOptimizationStack } from '../lib/image-optimization-stack';
import * as dotenv from "dotenv";
import { USEastStack } from "../lib/us-east-res-stack";

dotenv.config();

if (!process.env.APP_ID) {
  throw new Error("Missing App ID");
}

const app = new cdk.App();


let usStack;

if (process.env.DOMAIN_NAME) {
  usStack = new USEastStack(app, `${process.env.APP_ID}-USEast`, {
    env: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region: "us-east-1"
    },
    crossRegionReferences: true
  });
}

new ImageOptimizationStack(app, process.env.APP_ID, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: "eu-central-1",
  },
  crossRegionReferences: true
}, usStack?.cert, usStack?.waf);
