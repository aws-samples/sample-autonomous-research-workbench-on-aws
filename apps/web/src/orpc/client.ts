import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/fetch'
import { createTanstackQueryUtils } from '@orpc/tanstack-query'
import { getRequestHeaders } from '@tanstack/react-start/server'
import { createIsomorphicFn } from '@tanstack/react-start'

import type { RouterClient } from '@orpc/server'
import type { router } from '@repo/orpc'

import { SERVICE_URL } from '#/lib/config'

const getORPCClient = createIsomorphicFn()
  .client(
    (): RouterClient<typeof router> =>
      createORPCClient(
        new RPCLink({
          url: `${SERVICE_URL}/rpc`,
          fetch: (input, init) =>
            fetch(input, { ...init, credentials: 'include' }),
        }),
      ),
  )
  .server(
    (): RouterClient<typeof router> =>
      createORPCClient(
        new RPCLink({
          url: `${SERVICE_URL}/rpc`,
          headers: () => getRequestHeaders(),
        }),
      ),
  )

export const client: RouterClient<typeof router> = getORPCClient()

export const orpc = createTanstackQueryUtils(client)
