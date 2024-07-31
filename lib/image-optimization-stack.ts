import {
  Fn,
  Stack,
  StackProps,
  RemovalPolicy,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_lambda as lambda,
  aws_iam as iam,
  Duration,
  CfnOutput,
  aws_logs as logs,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { getOriginShieldRegion } from './origin-shield';
import { Architecture } from 'aws-cdk-lib/aws-lambda';
import { HttpVersion } from 'aws-cdk-lib/aws-cloudfront';

// Define parameters
const STORE_TRANSFORMED_IMAGES = 'true';
const S3_IMAGE_BUCKET_NAME: string | undefined = process.env.S3_IMAGE_BUCKET_NAME;
const CLOUDFRONT_ORIGIN_SHIELD_REGION = getOriginShieldRegion(process.env.AWS_REGION || process.env.CDK_DEFAULT_REGION || 'eu-central-1');
const CLOUDFRONT_CORS_ENABLED = 'true';
const S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION = '90';
const S3_TRANSFORMED_IMAGE_CACHE_TTL = 'max-age=31622400';
const MAX_IMAGE_SIZE = '4700000';
const LAMBDA_MEMORY = '1500';
const LAMBDA_TIMEOUT = '20';

type LambdaEnv = {
  originalImageBucketName: string,
  transformedImageBucketName?: string,
  transformedImageCacheTTL: string,
  maxImageSize: string,
}

export class ImageOptimizationStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Set up buckets
    const { originalImageBucket, transformedImageBucket } = this.setupBuckets();

    // Set up Lambda environment
    const lambdaEnv: LambdaEnv = {
      originalImageBucketName: originalImageBucket.bucketName,
      transformedImageBucketName: transformedImageBucket?.bucketName,
      transformedImageCacheTTL: S3_TRANSFORMED_IMAGE_CACHE_TTL,
      maxImageSize: MAX_IMAGE_SIZE,
    };

    // Create Lambda function
    const imageProcessing = this.createLambdaFunction(lambdaEnv, originalImageBucket, transformedImageBucket);

    // Set up CloudFront distribution
    this.setupCloudFrontDistribution(imageProcessing, transformedImageBucket);
  }

  private setupBuckets() {
    let originalImageBucket;
    let transformedImageBucket;

    if (S3_IMAGE_BUCKET_NAME) {
      originalImageBucket = s3.Bucket.fromBucketName(this, `OriginalImageBucket-${this.node.addr}`, S3_IMAGE_BUCKET_NAME);
    } else {
      originalImageBucket = new s3.Bucket(this, `OriginalImageBucket-${this.node.addr}`, {
        removalPolicy: RemovalPolicy.DESTROY,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
        enforceSSL: true,
        autoDeleteObjects: true,
      });
    }

    if (STORE_TRANSFORMED_IMAGES === 'true') {
      transformedImageBucket = new s3.Bucket(this, `TransformedImageBucket-${this.node.addr}`, {
        removalPolicy: RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
        lifecycleRules: [{ expiration: Duration.days(parseInt(S3_TRANSFORMED_IMAGE_EXPIRATION_DURATION)) }],
      });
    }

    new CfnOutput(this, 'OriginalImagesS3Bucket', {
      description: 'S3 bucket where original images are stored',
      value: originalImageBucket.bucketName,
    });

    if (transformedImageBucket) {
      new CfnOutput(this, 'TransformedImagesS3Bucket', {
        description: 'S3 bucket where transformed images are stored',
        value: transformedImageBucket.bucketName,
      });
    }

    return { originalImageBucket, transformedImageBucket };
  }

  private createLambdaFunction(lambdaEnv: LambdaEnv, originalImageBucket: s3.IBucket, transformedImageBucket?: s3.IBucket) {
    const imageProcessing = new lambda.Function(this, `ImageProcessingFunction-${this.node.addr}`, {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('functions/image-processing'),
      timeout: Duration.seconds(parseInt(LAMBDA_TIMEOUT)),
      memorySize: parseInt(LAMBDA_MEMORY),
      environment: lambdaEnv,
      logRetention: logs.RetentionDays.ONE_DAY,
      architecture: Architecture.ARM_64,
    });

    const s3ReadPolicy = new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [`arn:aws:s3:::${originalImageBucket.bucketName}/*`],
    });

    imageProcessing.addToRolePolicy(s3ReadPolicy);

    if (transformedImageBucket) {
      const s3WritePolicy = new iam.PolicyStatement({
        actions: ['s3:PutObject'],
        resources: [`arn:aws:s3:::${transformedImageBucket.bucketName}/*`],
      });

      imageProcessing.addToRolePolicy(s3WritePolicy);
    }

    return imageProcessing;
  }

  private setupCloudFrontDistribution(imageProcessing: lambda.Function, transformedImageBucket?: s3.IBucket) {
    const imageProcessingURL = imageProcessing.addFunctionUrl();
    const imageProcessingDomainName = Fn.parseDomainName(imageProcessingURL.url);

    const urlRewriteFunction = new cloudfront.Function(this, `URLRewriteFunction-${this.node.addr}`, {
      code: cloudfront.FunctionCode.fromFile({ filePath: 'functions/url-rewrite/index.js' }),
    });

    const origin = transformedImageBucket
      ? new origins.OriginGroup({
          primaryOrigin: new origins.S3Origin(transformedImageBucket, { originShieldRegion: CLOUDFRONT_ORIGIN_SHIELD_REGION }),
          fallbackOrigin: new origins.HttpOrigin(imageProcessingDomainName, { originShieldRegion: CLOUDFRONT_ORIGIN_SHIELD_REGION }),
          fallbackStatusCodes: [403, 500, 503, 504],
        })
      : new origins.HttpOrigin(imageProcessingDomainName, { originShieldRegion: CLOUDFRONT_ORIGIN_SHIELD_REGION });

    const responseHeadersPolicy = CLOUDFRONT_CORS_ENABLED === 'true'
      ? new cloudfront.ResponseHeadersPolicy(this, `ResponseHeadersPolicy-${this.node.addr}`, {
          corsBehavior: {
            accessControlAllowCredentials: false,
            accessControlAllowHeaders: ['*'],
            accessControlAllowMethods: ['GET'],
            accessControlAllowOrigins: ['*'],
            accessControlMaxAge: Duration.seconds(600),
            originOverride: false,
          },
          customHeadersBehavior: {
            customHeaders: [
              { header: 'x-cdn-image-optimization', value: 'v1.0', override: true },
              { header: 'vary', value: 'accept', override: true },
            ],
          },
        })
      : undefined;

    const cachePolicy = new cloudfront.CachePolicy(this, `ImageCachePolicy-${this.node.addr}`, {
      defaultTtl: Duration.hours(24),
      maxTtl: Duration.days(365),
      minTtl: Duration.seconds(0),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
      enableAcceptEncodingBrotli: true,
      enableAcceptEncodingGzip: true,
      cachePolicyName: `ImageCachePolicy-AllowQueryStrings-${this.node.addr}`
    });

    const distribution = new cloudfront.Distribution(this, `ImageDeliveryDistribution-${this.node.addr}`, {
      httpVersion: HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        cachePolicy,
        functionAssociations: [{
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          function: urlRewriteFunction,
        }],
        responseHeadersPolicy,
      },
    });

    const oac = new cloudfront.CfnOriginAccessControl(this, `OriginAccessControl-${this.node.addr}`, {
      originAccessControlConfig: {
        name: `OAC-${this.node.addr}`,
        originAccessControlOriginType: 'lambda',
        signingBehavior: 'always',
        signingProtocol: 'sigv4',
      },
    });

    const cfnDistribution = distribution.node.defaultChild as cloudfront.CfnDistribution;
    const originIndex = transformedImageBucket ? 1 : 0;
    cfnDistribution.addPropertyOverride(`DistributionConfig.Origins.${originIndex}.OriginAccessControlId`, oac.getAtt('Id'));

    imageProcessing.addPermission('AllowCloudFrontServicePrincipal', {
      principal: new iam.ServicePrincipal('cloudfront.amazonaws.com'),
      action: 'lambda:InvokeFunctionUrl',
      sourceArn: `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
    });

    new CfnOutput(this, 'ImageDeliveryDomain', {
      description: 'Domain name of image delivery',
      value: distribution.distributionDomainName,
    });
  }
}
