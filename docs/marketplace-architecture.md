# Arquitetura de conexões de marketplace

## Diagnóstico do ponto de partida

O repositório começou como um vertical slice Amazon em memória: `AmazonProvider` fazia LWA e SP-API; `AmazonConnectionService` mantinha conexão/callback; `AesGcmCredentialVault` protegia credenciais; e `createAmazonHostedApi` expunha Connect Sessions por Secret Key. Não havia autenticação de usuário Chameleon, RBAC de workspace, tentativas persistentes independentes, seleção de recursos, estado de sincronização, filas/workers ou adaptadores para outros marketplaces.

## Princípios Clerk e decisões Chameleon

Da Clerk, o Chameleon adota a separação entre API pública no browser, chave publicável, sessão autenticada, API de backend por Secret Key e tela hospedada de redirecionamento. Isso permite que uma interface inicie a conexão com uma chamada do SDK, sem implementar OAuth no produto cliente.

O que é específico do Chameleon é que a autorização do usuário Chameleon não é a autorização do seller no marketplace. A primeira controla quem pode conectar/desconectar uma integração no workspace; a segunda concede acesso da conta externa. Uma conexão também não determina se a sincronização está saudável: `authorizationStatus` e `syncState` são independentes.

## Modelo de domínio implementado

| Conceito | Implementação de referência | Regra importante |
| --- | --- | --- |
| `ConnectionAttempt` | estado efêmero em `AmazonConnectionService` | é vinculado no servidor a environment, workspace, usuário iniciador, intenção e destino permitido |
| `MarketplaceConnection` | `PublicConnection` | vínculo persistente lógico com o workspace; ciclo de autorização separado de sync |
| `CredentialSet` | `CredentialVault` AES-256-GCM | credenciais novas ficam em escopo da tentativa antes de serem promovidas à conexão |
| `MarketplaceResource` | recursos Amazon descobertos via marketplace participation | usa identificador estável do provider; não nome/e-mail |
| `SyncState` | `NOT_STARTED`, `QUEUED`, `SYNCING`, `HEALTHY`, `DEGRADED`, `FAILED`, `DISABLED` | workers atualizam somente sync, nunca reclassificam uma autorização válida como desconectada |

Uma tentativa usa `created`, `awaiting_authorization`, `processing`, `awaiting_selection`, `completed`, `failed`, `cancelled` ou `expired`. O retorno ao produto contém `attempt_id`, `connection_id`, `connection_status` e nenhum código OAuth, token ou segredo.

Nesta referência, o mesmo seller Amazon só pode estar ligado a um workspace por environment; uma segunda associação é rejeitada sem revelar o workspace que já o possui. `disconnect` libera essa associação. Em uma implementação multi-região, a chave de unicidade deve incluir a região do provider.

## Fronteiras de confiança

```text
UI Chameleon ── pk_ + sessão Chameleon ──► Frontend API ─┐
                                                         ├─► valida RBAC do workspace
Backend do cliente ── sk_ ─────────────────► Backend API ─┘        │
                                                                     ▼
                                                          ConnectionAttempt
                                                                     │
Seller Central / provider callback ─────────► Hosted Connect ───────┤
                                                                     ▼
                                                            Credential Vault
                                                                     │
                                                         worker/outbox de sync
```

`WorkspaceAuthorizer` é a fronteira para o RBAC real do Chameleon. A implementação de referência mantém o comportamento legado de Secret Key confiável quando ele não é configurado; em produção ele deve ser obrigatório. A rota pública (`/v1/frontend/connect_sessions`) exige tanto um autenticador de sessão quanto `WorkspaceAuthorizer`. A origem do browser também deve ser permitida por `isAllowedFrontendOrigin` para habilitar CORS.

## Contratos HTTP atuais

| Rota | Autenticação | Função |
| --- | --- | --- |
| `POST /v1/frontend/connect_sessions` | `pk_` + sessão Chameleon | inicia a UX direta do browser |
| `GET/POST /v1/frontend/connections/*` e `/v1/frontend/connection_attempts/*` | `pk_` + sessão Chameleon | leitura, seleção, reconnect, disconnect e cancelamento na interface |
| `POST /v1/connect_sessions` | `sk_` | compatibilidade para backends confiáveis |
| `GET /v1/marketplaces` | `sk_` | catálogo de disponibilidade e capacidades por provider |
| `GET /v1/connection_attempts/:id` | `sk_` | consulta uma tentativa sem segredos |
| `POST /v1/connection_attempts/:id/cancel` | `sk_` | cancela tentativa em aberto |
| `GET /v1/connections/:id` | `sk_` | consulta autorização, recursos, permissões e sync |
| `POST /v1/connections/:id/resources` | `sk_` | seleciona recursos quando o provider exige essa etapa |
| `POST /v1/connections/:id/reconnect` | `sk_` | cria nova tentativa para a mesma conexão |
| `POST /v1/connections/:id/disconnect` | `sk_` | cessa uso das credenciais e desabilita sync |

Os endpoints de callback Amazon continuam internos ao domínio hospedado do Chameleon.

## Capacidade por marketplace

| Marketplace | Estado neste repositório | Fatos confirmados que guiam o adapter |
| --- | --- | --- |
| Amazon | **operacional (US)** | autorização de website/LWA, descoberta de marketplaces e SigV4; seleção opcional de marketplaces |
| eBay | documentado, não configurado | Application token e User token são distintos; dados do seller exigem User token, consentimento e RuName/scopes |
| TikTok Shop | documentado, não configurado | seller access/refresh tokens, escopos concedidos e descoberta de lojas autorizadas; operações de loja usam `shop_cipher` quando exigido |
| Temu | documentado, não configurado | suporte oficial a autorização manual e por callback; o fluxo varia por tipo/região do seller |
| Walmart | documentado, não configurado | OAuth para Solution Providers aprovados; instalação pode começar pelo App Store e usa code/refresh token |

As entradas não Amazon ficam no `MarketplaceProviderRegistry` com `availability: "not_configured"`. Não há endpoints, scopes, tempos de expiração ou formatos de credenciais inventados para elas.

Fontes oficiais: [Amazon SP-API](https://developer-docs.amazon.com/sp-api/docs/website-authorization-workflow), [eBay authorization](https://developer.ebay.com/develop/guides/sell/authorization), [TikTok Shop entity tags](https://partner.tiktokshop.com/docv2/page/api-entity-tags), [TikTok authorized shops](https://partner.tiktokshop.com/docv2/page/get-authorized-shops), [Temu Seller Authorization Guide](https://partner.temu.com/documentation?menu_code=38e79b35d2cb463d85619c1c786dd303) e [Walmart OAuth authorization](https://developer.walmart.com/us-marketplace/docs/oauth-20-authorization).

## Migração para produção

Esta entrega não adiciona banco, fila ou identidade Chameleon porque o repositório não possuía esses serviços. A migração deve criar tabelas/coleções equivalentes a `connection_attempts`, `marketplace_connections`, `authorization_grants`, `marketplace_resources`, `sync_states` e uma outbox de eventos. Índices únicos devem cobrir provider, environment, região quando aplicável e ID externo. As credenciais precisam ir para KMS/envelope encryption, não para o vault em memória.

Ao migrar, execute a leitura do estado Amazon existente como uma conexão com `syncState: NOT_STARTED`, crie uma tentativa somente para fluxos novos e não migre tokens para respostas públicas. Use lock distribuído por grant durante refresh e uma transação/outbox para promoção de credenciais, ativação da conexão e enfileiramento da primeira sincronização.

## Limitações deliberadas

- A implementação é uma referência em memória: não oferece durabilidade, lock distribuído, worker, queue, webhook ou revogação remota Amazon.
- A integração Amazon é US e depende de aplicação SP-API aprovada, callbacks HTTPS registrados, roles e seller de teste para validação real.
- Os demais adapters exigem onboarding, credenciais, ambiente/sandbox e contract tests por provider antes de serem habilitados.
- `@chameleon/react` ainda não é um pacote separado. O browser-safe `createChameleonFrontendClient` foi incluído no pacote de referência e pode embasar esse pacote público.
