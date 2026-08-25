import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface CognitoStackProps extends cdk.StackProps {
  isProd: boolean;
  /**
   * Public HTTPS URL of the app (the CloudFront front door). better-auth
   * handles the OAuth callback on the API behind /api/*, so the redirect URI
   * lives under this origin.
   */
  publicUrl: string;
}

/**
 * Standalone auth stack: user pool, hosted-UI domain and app client live in
 * their own CloudFormation stack so callback-URL changes can be deployed
 * without touching ECS/ALB/database:
 *
 *   cdk deploy ResearchWorkbench/Cognito
 */
export class CognitoStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly userPoolDomain: cognito.UserPoolDomain;
  /** M2M app client (client-credentials grant) the API uses to call the AgentCore Gateway. */
  public readonly gatewayM2mClient: cognito.UserPoolClient;
  /** The M2M client's secret, mirrored into Secrets Manager for ECS injection. */
  public readonly gatewayM2mClientSecret: secretsmanager.Secret;
  /** Full OAuth scope string ("<resource-server>/<scope>") to request in the token call. */
  public readonly gatewayOauthScope: string;

  constructor(scope: Construct, id: string, props: CognitoStackProps) {
    super(scope, id, props);

    this.userPool = new cognito.UserPool(this, 'User Pool', {
      userPoolName: 'research-workbench',
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
        fullname: { required: true, mutable: true },
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      removalPolicy: props.isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    });

    this.userPoolDomain = this.userPool.addDomain('Hosted Domain', {
      cognitoDomain: {
        domainPrefix: `research-workbench-${this.account}`,
      },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    this.userPoolClient = this.userPool.addClient('App Client', {
      userPoolClientName: 'research-workbench',
      generateSecret: false,
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [cognito.OAuthScope.EMAIL, cognito.OAuthScope.OPENID, cognito.OAuthScope.PROFILE],
        callbackUrls: [
          // Local API service — better-auth lives in apps/api on :4000
          'http://localhost:4000/api/auth/callback/cognito',
          `${props.publicUrl}/api/auth/callback/cognito`,
        ],
      },
      authFlows: {
        userSrp: true,
      },
      preventUserExistenceErrors: true,
    });

    // ── AgentCore Gateway M2M auth ──
    // The gateway's inbound authorizer validates Cognito-issued JWTs. The API
    // (and any future scheduler/webhook trigger) obtains a token via the
    // client_credentials grant — no user is involved; the token represents the
    // platform itself. The resource server defines the custom scope the grant
    // is issued against.
    const gatewayScope = new cognito.ResourceServerScope({
      scopeName: 'invoke',
      scopeDescription: 'Invoke AgentCore Gateway MCP tools',
    });

    const gatewayResourceServer = this.userPool.addResourceServer('Gateway Resource Server', {
      identifier: 'agentcore-gateway',
      scopes: [gatewayScope],
    });

    this.gatewayOauthScope = `agentcore-gateway/${gatewayScope.scopeName}`;

    this.gatewayM2mClient = this.userPool.addClient('Gateway M2M Client', {
      userPoolClientName: 'research-workbench-gateway-m2m',
      generateSecret: true,
      oAuth: {
        flows: {
          clientCredentials: true,
        },
        scopes: [cognito.OAuthScope.resourceServer(gatewayResourceServer, gatewayScope)],
      },
    });
    this.gatewayM2mClient.node.addDependency(gatewayResourceServer);

    // ECS can only inject secrets from Secrets Manager / SSM, so mirror the
    // generated client secret there rather than resolving it into the task
    // definition as plaintext.
    this.gatewayM2mClientSecret = new secretsmanager.Secret(this, 'Gateway M2M Client Secret', {
      description: 'Cognito client secret for the AgentCore Gateway M2M app client',
      secretStringValue: this.gatewayM2mClient.userPoolClientSecret,
    });

    new cognito.CfnManagedLoginBranding(this, 'Managed Login Branding', {
      userPoolId: this.userPool.userPoolId,
      clientId: this.userPoolClient.userPoolClientId,
      useCognitoProvidedValues: true,
    });
  }
}
