# Chameleon Marketplace Connections

Infraestrutura hospedada, no estilo Clerk, para conectar sellers de marketplace sem expor tokens, callbacks, credenciais AWS ou segredos das aplicações dos providers. Amazon SP-API US é o único adapter operacional desta referência.

## O que mudou

- `ConnectionAttempt` recuperável e vinculado a environment, workspace, usuário e intenção.
- autorização da conta externa, permissões/recursos e `SyncState` agora são estados separados.
- Frontend API com Publishable Key + sessão Chameleon + RBAC de workspace.
- cliente browser-safe com `connect()` para a interface abrir o Hosted Connect sem criar uma rota `POST` própria.
- seleção opcional de marketplaces Amazon antes de ativar a conexão.
- credenciais de callbacks/reconnect são staged e criptografadas até validar seller e recursos.
- catálogo explícito para Amazon, eBay, TikTok Shop, Temu e Walmart; apenas Amazon está habilitado.

Consulte a [arquitetura e plano de migração](./docs/marketplace-architecture.md) para contratos, limitações e fontes oficiais.

## Uso na interface

> Este repositório ainda é privado e não publica pacotes npm. O cliente abaixo é a API que deverá compor `@chameleon/frontend` ou `@chameleon/react`; use o alias/artefato interno equivalente até a publicação.

```tsx
"use client";

import { createChameleonFrontendClient } from "@chameleon/frontend";

declare function getChameleonSessionToken(): Promise<string>;

const chameleon = createChameleonFrontendClient({
  publishableKey: process.env.NEXT_PUBLIC_CHAMELEON_PUBLISHABLE_KEY!,
  // Prova de sessão do próprio Chameleon, obtida pelo seu adaptador de auth.
  sessionToken: getChameleonSessionToken,
});

export function ConnectAmazonButton() {
  return (
    <button
      onClick={() =>
        chameleon.connect({
          provider: "amazon",
          organizationId: "org_da_empresa_logada",
          returnUrl: "https://app.example.com/integrations",
        })
      }
    >
      Conectar Amazon
    </button>
  );
}
```

`connect()` cria a tentativa e navega ao Hosted Connect. A interface não faz troca de código, refresh, assinatura SP-API ou armazenamento de token. O servidor Chameleon deve resolver o usuário pela sessão, validar sua permissão no workspace e liberar a origem do browser por CORS.

Após consentimento, a `returnUrl` recebe somente dados seguros:

```text
https://app.example.com/integrations?connection_id=conn_123&connection_status=connected&attempt_id=attempt_123
```

Para acompanhar uma seleção pendente, consulte a tentativa e a conexão no backend. A conexão devolve `authorizationStatus`, `resources`, `permissions` e `syncState`; ela nunca devolve credenciais Amazon.

## Uso pelo backend (compatibilidade)

```ts
import { createChameleonClient } from "@chameleon/backend";

const chameleon = createChameleonClient({
  secretKey: process.env.CHAMELEON_SECRET_KEY!,
});

const session = await chameleon.connectSessions.create({
  organizationId: "org_da_empresa_logada",
  provider: "amazon",
  returnUrl: "https://app.example.com/integrations",
  idempotencyKey: crypto.randomUUID(),
});

const connection = await chameleon.connections.get(session.connectionId);

if (connection.resources.some((resource) => !resource.selected)) {
  await chameleon.connections.selectResources(
    connection.id,
    connection.resources.filter((resource) => resource.providerResourceId === "ATVPDKIKX0DER").map((resource) => resource.id),
  );
}
```

`sk_` nunca pertence ao browser. A Backend API é útil para jobs administrativos, leitura de conexão e produtos que preferirem criar a sessão no próprio backend.

## Configuração interna do Chameleon

O handler HTTP é framework-neutral (`Request`/`Response`). Integre autenticação real de Secret Key, sessão Chameleon, RBAC de workspace e allowlists de retorno/origem:

```ts
const api = createAmazonHostedApi({
  connectionService: connections,
  connectOrigin: "https://connect.chameleon.dev",
  authenticateSecretKey: secretKeyAuthenticator,
  authenticateFrontendSession: chameleonSessionAuthenticator,
  workspaceAuthorizer: chameleonWorkspaceAuthorizer,
  isAllowedFrontendOrigin: (origin) => origin === "https://app.example.com",
  isAllowedReturnUrl: ({ returnUrl }) => returnUrl === "https://app.example.com/integrations",
});
```

Rotas disponíveis:

- `POST /v1/frontend/connect_sessions` — browser: `pk_` + sessão Chameleon.
- `GET /v1/frontend/connections/:id`, `POST /resources`, `/reconnect` e `/disconnect` — interface autenticada.
- `GET /v1/frontend/connection_attempts/:id` e `POST /cancel` — estado recuperável na interface.
- `POST /v1/connect_sessions` — backend: `sk_`.
- `GET /v1/marketplaces` — catálogo de providers/capacidades para o backend.
- `GET /v1/connection_attempts/:id` e `POST /v1/connection_attempts/:id/cancel`.
- `GET /v1/connections/:id`, `POST /v1/connections/:id/resources`, `/reconnect` e `/disconnect`.
- `GET /connect/amazon` e callbacks internos em `/v1/providers/amazon/*`.

As configurações Amazon e as chaves de criptografia permanecem exclusivamente no secret manager da plataforma. Consulte [.env.example](./.env.example) e [docs/amazon-sp-api.md](./docs/amazon-sp-api.md).

## Marketplace status

| Provider | Situação |
| --- | --- |
| Amazon US | Implementado com mocks: hosted authorization, LWA, SigV4, descoberta de marketplaces, refresh, reconnect, seleção e disconnect |
| eBay | Documentado no registry; adapter não configurado |
| TikTok Shop | Documentado no registry; adapter não configurado |
| Temu | Documentado no registry; adapter não configurado |
| Walmart | Documentado no registry; adapter não configurado |

## Desenvolvimento e testes

Requer Node.js 22.6 ou superior.

```bash
npm install
npm run typecheck
npm test
npm run check
```

Os testes são simulados, sem rede ou credenciais reais. A coleção [Bruno](./bruno/README.md) cobre o contrato de Backend API. Validação Amazon real ainda requer aplicação SP-API pública aprovada, callbacks HTTPS registrados, roles adequadas e seller US de teste.
