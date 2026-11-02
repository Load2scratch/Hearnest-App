# Deploy HEARNEST to Vercel

## Fix signup returning HTTP 503

The serverless backend requires shared Redis storage and a stable authentication
secret. A local JSON file cannot provide persistent account storage on Vercel.

1. Open your project in Vercel. Install an Upstash Redis integration from the
   Marketplace and connect a database to this project for Production. If you
   already have an Upstash database, use its REST credentials instead.
2. In **Settings > Environment Variables**, set these server-only values for
   **Production**:

   | Name | Value |
   | --- | --- |
   | `UPSTASH_REDIS_REST_URL` | The HTTPS REST URL from your Upstash Redis database |
   | `UPSTASH_REDIS_REST_TOKEN` | The REST token with read/write access from that same database |
   | `AUTH_SECRET` | A cryptographically random value of at least 32 characters |
   | `APP_ORIGIN` | `https://hearnest-learn.vercel.app` |

   The backend also accepts `KV_REST_API_URL` and `KV_REST_API_TOKEN` in place
   of the two `UPSTASH_` names. Check which names your integration added.
   Use REST credentials, not a `redis://` connection string or a read-only token.
   Do not add quotes around dashboard values.
3. Generate `AUTH_SECRET` locally with Node.js, then paste the output directly
   into Vercel:

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

   Keep this value stable across deployments. Keep all credentials out of HTML,
   source control, and chat messages.
4. Deploy the latest project source, including `api/index.js`, `backend/`,
   `scripts/build.cjs`, and `vercel.json`. This version returns specific, safe
   configuration errors instead of the older generic message. Changing
   environment variables alone does not update an existing deployment: create a
   new Production deployment after saving the values.
5. Open `https://hearnest-learn.vercel.app/api/auth/session`. A working backend
   returns HTTP 200 with a `csrfToken` and a `user` field. For a signed-out
   browser, `user` is `null`. Refresh the signup page and create an account.

## If it still fails

- `MISSING_REDIS_CONFIG`: check the URL/token variable names, project connection,
  and Production scope.
- `INVALID_REDIS_URL`: use the HTTPS REST URL from Upstash.
- `INVALID_AUTH_SECRET`: generate a random secret of at least 32 characters.
- `INVALID_APP_ORIGIN`: use the exact HTTPS website origin above.
- Storage unavailable: check that the database is active and its REST token has
  read/write access. Review the Vercel Function logs for the latest deployment.
- The old generic configuration message: confirm the production domain points
  to a deployment of the latest source.

After changing settings, deploy again. For Preview deployments, configure
credentials in the Preview environment too; omit a Production-only
`APP_ORIGIN` override there so the backend can use Vercel's deployment URL.

## References

- [Vercel environment variables](https://vercel.com/docs/environment-variables)
- [Redis on Vercel](https://vercel.com/docs/redis)
- [Upstash REST credentials](https://upstash.com/docs/redis/howto/connect-with-upstash-redis)
