import { db } from "@repo/database";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin } from "better-auth/plugins";

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL,
  trustedOrigins: process.env.TRUSTED_ORIGINS?.split(",") ?? [
    "http://localhost:3000",
  ],
  database: drizzleAdapter(db, {
    provider: "pg",
  }),
  socialProviders: {
    cognito: {
      clientId: process.env.COGNITO_CLIENT_ID as string,
      domain: process.env.COGNITO_DOMAIN as string,
      region: process.env.AWS_DEFAULT_REGION as string,
      userPoolId: process.env.COGNITO_USERPOOL_ID as string,
    },
  },
  plugins: [admin()],
});
