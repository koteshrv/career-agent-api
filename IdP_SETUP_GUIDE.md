# Identity Provider (IdP) Setup Guide

To secure your `/api/auth/login` endpoint in production, your frontend must authenticate the user via an Identity Provider (IdP) and send the resulting token to your API.

Here is how to set up the three requested providers:

## 1. Google (OpenID Connect)
Google is the easiest and most standard OIDC provider.

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new Project.
3. Navigate to **APIs & Services** > **Credentials**.
4. Click **Create Credentials** > **OAuth client ID**.
5. Choose **Web application**.
6. Add your frontend's URL to **Authorized JavaScript origins** and **Authorized redirect URIs**.
7. **How it works:** Your frontend uses the Google Sign-In SDK to prompt the user. Google gives your frontend an `id_token` (a JWT). Your frontend sends `{ "idp_token": "<google_id_token>", "sso_provider": "google" }` to your Career Agent API.

## 2. GitHub (OAuth 2.0)
GitHub does not issue standard JWTs (OIDC); they issue opaque OAuth Access Tokens.

1. Go to your GitHub account **Settings** > **Developer settings** > **OAuth Apps**.
2. Click **New OAuth App**.
3. Fill in your frontend Application name and Homepage URL.
4. Set the **Authorization callback URL** to your frontend's callback route.
5. **How it works:** Your frontend redirects the user to GitHub. GitHub redirects back to your frontend with a `code`. Your frontend exchanges that `code` for an `access_token`. Your frontend sends `{ "idp_token": "<github_access_token>", "sso_provider": "github" }` to your Career Agent API.
