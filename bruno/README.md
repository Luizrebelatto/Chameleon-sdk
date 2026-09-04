# Bruno — Amazon Connections

Coleção Bruno para testar a API hospedada do Chameleon para Amazon SP-API.

## Preparação

1. Abra a pasta `bruno/` no Bruno.
2. Selecione o ambiente **local** e edite os valores em `environments/local.bru`:
   - `baseUrl`: origem que encaminha as rotas da `createAmazonHostedApi`;
   - `secretKey`: uma Chameleon Secret Key de teste válida;
   - `organizationId`: organização de teste;
   - `returnUrl`: URL previamente permitida pelo `isAllowedReturnUrl`.
3. Execute as requests na sequência mostrada pelos números.

`01-create-amazon-connect-session` salva `attemptId`, `connectionId` e `connectUrl` como variáveis de runtime. As requests seguintes usam automaticamente os mesmos IDs.

## Hosted Connect e Amazon

`02-manual-open-hosted-connect` verifica apenas o primeiro `302` e deixa a URL do Seller Central em `sellerCentralUrl`. Ela deve ser aberta em um navegador, onde o vendedor fará login e consentirá com a Amazon.

O fluxo de callback não é automatizado pela coleção: ele exige uma aplicação SP-API aprovada, URIs HTTPS registradas e uma conta seller real/de teste. Nunca tente preencher `spapi_oauth_code`, tokens LWA ou credenciais AWS no Bruno; eles pertencem à infraestrutura Chameleon.

## Sequência segura para smoke test

1. Create Amazon Connect Session
2. Get Connection Attempt
3. Get Pending Connection
4. MANUAL - Open Hosted Connect (opcional; não inclua no Collection Runner)
5. Disconnect Connection
6. Reconnect Connection
7. Get Reconnected Connection

As assertions também confirmam que as respostas de conexão não contêm tokens Amazon.
