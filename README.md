# Chameleon Marketplace Connections

Infraestrutura hospedada para conectar contas de marketplaces sem expor OAuth, LWA, SP-API, tokens ou credenciais ao cliente. A primeira integração é **Amazon SP-API para sellers dos Estados Unidos**.

O modelo de uso é semelhante ao da Clerk:

- A aplicação do cliente usa uma **Chameleon Secret Key** apenas no backend.
- O backend cria uma Connect Session.
- O frontend encaminha o seller para o Hosted Connect.
- O Chameleon conduz a autorização na Amazon e guarda as credenciais.
- O cliente consulta a connection normalizada ou recebe um webhook — nunca tokens Amazon.

## Fluxo

```text
Backend do cliente
  └─ cria Connect Session com a Chameleon Secret Key
       └─ frontend abre Hosted Connect
            └─ seller autoriza no Seller Central
                 └─ Chameleon processa callback, LWA e SP-API
                      └─ cliente recebe connectionId/status seguro
```

## Uso pelo cliente Chameleon

> O pacote público planejado é `@chameleon/backend`. Enquanto ele não estiver publicado, os exemplos mostram a API que ele expõe.

### 1. Criar uma Connect Session no backend

Nunca coloque `CHAMELEON_SECRET_KEY` em código de browser.

```ts
import { createChameleonClient } from "@chameleon/backend";

const chameleon = createChameleonClient({
  secretKey: process.env.CHAMELEON_SECRET_KEY!,
});

export async function createAmazonConnectSession(organizationId: string) {
  return chameleon.connectSessions.create({
    organizationId,
    provider: "amazon",
    returnUrl: "https://app.example.com/integrations",
    idempotencyKey: crypto.randomUUID(),
  });
}
```

O retorno tem a forma:

```ts
{
  id: "cs_...",
  connectionId: "conn_...",
  connectUrl: "https://connect.chameleon.dev/connect/amazon?...",
  connectSessionToken: "...",
  expiresAt: "2026-09-03T12:10:00.000Z"
}
```

`connectSessionToken` é temporário e serve somente para abrir o Hosted Connect. Não o registre em logs, analytics ou localStorage.

### 2. Abrir o Hosted Connect no frontend

O frontend deve obter a URL do próprio backend e redirecionar o seller:

```ts
async function connectAmazon(organizationId: string) {
  const response = await fetch("/api/marketplaces/amazon/connect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ organizationId }),
  });

  const { connectUrl } = await response.json();
  window.location.assign(connectUrl);
}
```

O Hosted Connect troca a sessão temporária por cookie `Secure`, `HttpOnly` e `SameSite=Lax` antes de redirecionar à Amazon. Assim, o token temporário não acompanha o seller durante o fluxo OAuth.

### 3. Processar o retorno seguro

Após o consentimento, o Chameleon redireciona para a `returnUrl` cadastrada, contendo somente:

```text
https://app.example.com/integrations?connection_id=conn_123&connection_status=connected
```

O callback **não** contém `spapi_oauth_code`, LWA access token, refresh token, credenciais AWS nem credenciais da aplicação Amazon.

Na página de integração, leia o ID e consulte seu backend:

```ts
const params = new URLSearchParams(window.location.search);
const connectionId = params.get("connection_id");

if (connectionId) {
  const response = await fetch(`/api/marketplace-connections/${connectionId}`);
  const connection = await response.json();
  console.log(connection.status); // CONNECTED
  console.log(connection.account?.providerAccountId);
  console.log(connection.account?.marketplaceIds);
}
```

### 4. Consultar, reconectar e desconectar no backend

```ts
const connection = await chameleon.connections.get("conn_123");

if (connection.status === "REAUTHORIZATION_REQUIRED") {
  const session = await chameleon.connections.reconnect("conn_123", crypto.randomUUID());
  // Envie session.connectUrl ao frontend para iniciar uma nova autorização.
}

await chameleon.connections.disconnect("conn_123", crypto.randomUUID());
```

## Configuração interna da plataforma Chameleon

Este trecho pertence ao Chameleon — **não** à aplicação de quem consome o SDK. Ele cria o runtime Amazon e um handler HTTP baseado em Web Standards, utilizável em Node, Next.js, Hono ou outro adaptador compatível com `Request`/`Response`.

```ts
import {
  AesGcmCredentialVault,
  AmazonConnectionService,
  AmazonProvider,
  FetchHttpTransport,
  StaticSecretKeyAuthenticator,
  createAmazonHostedApi,
  systemClock,
} from "@chameleon/marketplace-connections";

const provider = new AmazonProvider(
  {
    applicationId: process.env.AMAZON_APPLICATION_ID!,
    lwaClientId: process.env.AMAZON_LWA_CLIENT_ID!,
    lwaClientSecret: process.env.AMAZON_LWA_CLIENT_SECRET!,
    awsCredentials: {
      accessKeyId: process.env.AMAZON_AWS_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AMAZON_AWS_SECRET_ACCESS_KEY!,
      ...(process.env.AMAZON_AWS_SESSION_TOKEN
        ? { sessionToken: process.env.AMAZON_AWS_SESSION_TOKEN }
        : {}),
    },
    loginUri: "https://connect.chameleon.dev/v1/providers/amazon/login",
    redirectUri: "https://connect.chameleon.dev/v1/providers/amazon/callback",
    applicationVersion: "draft", // use "production" após publicar na Amazon
    userAgent: "Chameleon/0.1.0 (Language=TypeScript)",
  },
  new FetchHttpTransport(),
  systemClock,
);

const connections = new AmazonConnectionService({
  provider,
  credentialVault: new AesGcmCredentialVault(process.env.AMAZON_CREDENTIAL_MASTER_KEY_BASE64!),
});

const amazonApi = createAmazonHostedApi({
  connectionService: connections,
  connectOrigin: "https://connect.chameleon.dev",
  // Apenas exemplo local. Em produção, use um store com hashes e rotação de Secret Keys.
  authenticateSecretKey: new StaticSecretKeyAuthenticator(
    new Map([[process.env.CHAMELEON_SECRET_KEY!, { environmentId: "env_test" }]]),
  ),
  isAllowedReturnUrl: ({ returnUrl }) => returnUrl === "https://app.example.com/integrations",
});

// Encaminhe as rotas abaixo para amazonApi(request):
// POST /v1/connect_sessions
// GET  /v1/connections/:connectionId
// POST /v1/connections/:connectionId/disconnect
// POST /v1/connections/:connectionId/reconnect
// GET  /connect/amazon
// GET  /v1/providers/amazon/login
// GET  /v1/providers/amazon/callback
```

Em produção, substitua os componentes de referência por PostgreSQL, KMS, key store com hash/rotação, lock distribuído, fila de refresh e outbox de webhooks.

## Variáveis de ambiente internas

Copie [.env.example](./.env.example) para o seu secret manager. Estes valores são exclusivos da infraestrutura Chameleon:

- `AMAZON_APPLICATION_ID`
- `AMAZON_LWA_CLIENT_ID`
- `AMAZON_LWA_CLIENT_SECRET`
- `AMAZON_AWS_ACCESS_KEY_ID`
- `AMAZON_AWS_SECRET_ACCESS_KEY`
- `AMAZON_AWS_SESSION_TOKEN` (quando aplicável)
- `AMAZON_CREDENTIAL_MASTER_KEY_BASE64` — exatamente 32 bytes codificados em Base64

## Amazon US

- Seller Central: `https://sellercentral.amazon.com`
- SP-API North America: `https://sellingpartnerapi-na.amazon.com`
- Região para assinatura AWS SigV4: `us-east-1`
- Marketplace ID US: `ATVPDKIKX0DER`

O provider usa o fluxo de autorização de website da Amazon, LWA e `GET /sellers/v1/marketplaceParticipations`. Detalhes e fontes estão em [docs/amazon-sp-api.md](./docs/amazon-sp-api.md).

## Desenvolvimento e testes

Requer Node.js 22.6 ou superior.

```bash
npm install
npm run typecheck
npm test
npm run check
```

Os testes não usam rede nem credenciais Amazon reais. Eles validam autorização, callbacks, exchange LWA, vault criptografado, assinatura SigV4, seller identity, refresh, reconnect, disconnect, SDK backend e o fluxo Hosted Connect completo.

## Smoke tests com Bruno

A coleção nativa do Bruno está em [bruno/](./bruno). Ela cria uma Connect Session, consulta a conexão pendente, valida o primeiro redirect do Hosted Connect e testa disconnect/reconnect sem nunca manipular credenciais Amazon.

Edite apenas os placeholders de `bruno/environments/local.bru` — em especial `baseUrl` e `secretKey` — e abra a pasta no Bruno. O guia e a ordem de execução estão em [bruno/README.md](./bruno/README.md).

## Validação real pendente

Para validar contra a Amazon ainda são necessários uma aplicação SP-API pública aprovada, callbacks registrados, roles adequadas e uma conta seller US de teste. Consulte [TASKS-AMAZON.md](./TASKS-AMAZON.md) para o status detalhado.
