# Amazon Connect — contrato Chameleon

## Fluxo preferido de interface

O browser usa `createChameleonFrontendClient` com Publishable Key e prova de sessão Chameleon. A chamada `connect()` cria uma `ConnectionAttempt` e redireciona para o Hosted Connect. A `Secret Key`, LWA, SP-API, AWS SigV4 e callbacks ficam fora da aplicação cliente.

O Frontend API só aceita a ação se o autenticador de sessão identificar o usuário e `WorkspaceAuthorizer` conceder `connection:create` para o workspace. `organizationId` recebido do browser não é suficiente para definir propriedade.

## Estados públicos

- Tentativa: `awaiting_authorization` → `processing` → `completed`, ou `awaiting_selection`, `failed`, `cancelled`/`expired`.
- Autorização persistente: `PENDING`, `CONNECTED`, `REAUTHORIZATION_REQUIRED`, `DISCONNECTED` ou `FAILED`.
- Sincronização: `NOT_STARTED`, `QUEUED`, `SYNCING`, `HEALTHY`, `DEGRADED`, `FAILED` ou `DISABLED`.

Uma falha de importação muda `syncState`, não `authorizationStatus`. O logout da sessão Chameleon também não desconecta o seller.

## Recursos e reconexão

Amazon descobre marketplaces ativos por `GET /sellers/v1/marketplaceParticipations`. Em configurações com `requireResourceSelection`, as credenciais ficam criptografadas em um escopo temporário da tentativa até a interface chamar `POST /v1/connections/:id/resources` com os IDs de recursos escolhidos.

Em reconnect, o seller retornado precisa coincidir com o `providerAccountId` conhecido antes de credenciais novas substituírem as atuais. Callbacks de tentativa antiga ou de conexão desconectada falham por correlação/estado e não reativam a integração.

## Dados devolvidos à interface

O retorno seguro contém `connection_id`, `connection_status` e `attempt_id`. Consultas de conexão podem conter conta normalizada, recursos, permissões conhecidas e sync. Elas nunca incluem `spapi_oauth_code`, LWA access token, refresh token, credenciais AWS ou segredo de aplicação Amazon.

## Produção

Substitua os componentes em memória por banco transacional, KMS/envelope encryption, store single-use para tentativas/callbacks, locks distribuídos para refresh, outbox e workers. A primeira sincronização deve ser enfileirada somente depois que a conexão for ativada; ela não deve rodar no callback HTTP.

Detalhes oficiais do fluxo Amazon estão em [amazon-sp-api.md](./amazon-sp-api.md). A visão multi-provider está em [marketplace-architecture.md](./marketplace-architecture.md).
