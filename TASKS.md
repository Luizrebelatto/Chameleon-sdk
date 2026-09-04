# Backlog — Chameleon Marketplace Connections

## Visão do produto

O Chameleon será uma plataforma de conexões com marketplaces distribuída por SDKs, seguindo o mesmo princípio de Developer Experience da Clerk:

- o cliente instala uma library pequena e tipada;
- a library conversa com APIs hospedadas pelo Chameleon;
- o Chameleon controla OAuth, callbacks, credenciais, refresh, segurança e integrações;
- o cliente usa uma **Publishable Key** no frontend e uma **Secret Key** no backend;
- ambientes de desenvolvimento e produção são isolados;
- componentes prontos coexistem com APIs para fluxos customizados.

Isso não significa copiar autenticação de usuários da Clerk. O recurso principal do Chameleon é `MarketplaceConnection`, não `User` ou `Session`.

Referências conceituais:

- [Clerk API overview](https://clerk.com/docs/reference/api/overview)
- [Clerk backend client](https://clerk.com/docs/reference/backend/overview)
- [Clerk SDK types](https://clerk.com/docs/guides/development/sdk-development/types)

## Arquitetura-alvo

```text
                         CUSTOMER APPLICATION
                  ┌──────────────┴──────────────┐
                  │                             │
          @chameleon/react              @chameleon/backend
           Publishable Key                 Secret Key
                  │                             │
                  ▼                             ▼
        Chameleon Frontend API       Chameleon Backend API
                  │                             │
                  └──────────────┬──────────────┘
                                 ▼
                      Connection Orchestrator
                                 │
             ┌───────────────────┼───────────────────┐
             │                   │                   │
        OAuth State        Credential Vault     Event/Webhooks
             │                   │                   │
             └───────────────────┼───────────────────┘
                                 ▼
                       Internal Provider Layer
              Etsy / eBay / Walmart / TikTok / Amazon / Temu
```

## Limites de responsabilidade

### Chameleon hospeda e controla

- Backend API e Frontend API.
- Hosted Connect UI e callbacks OAuth.
- Cadastro de aplicações, ambientes e chaves.
- Provider app credentials e seller tokens.
- Banco de connections/accounts e credential vault.
- Token refresh, retries, rate limits, locks e auditoria.
- Webhooks de mudança de estado para clientes.
- Dashboard de configuração e observabilidade.

### O cliente controla

- Usuário e organization da própria aplicação.
- Chamada backend que cria uma Connect Session.
- Momento e UI em que a conexão é iniciada.
- Associação entre seus IDs externos e recursos Chameleon.
- Tratamento dos webhooks/eventos recebidos.
- Secret Key somente no backend e Publishable Key no frontend.

### Fora do MVP

- Execução local/standalone dos adapters de marketplace na aplicação do cliente.
- Entrega de refresh tokens ou client secrets ao cliente.
- Orders, products, inventory, fulfillment e finance.
- SDKs mobile nativos.
- Marketplace app credentials fornecidas pelo cliente (BYOC), salvo provider que exija isso.

## Modelo de recursos

```text
Application
└── Environment (test | live)
    ├── Publishable Key
    ├── Secret Keys
    ├── Allowed Origins / Redirect URLs
    ├── Webhook Endpoints
    └── Organization (externalId)
        └── MarketplaceConnection
            ├── MarketplaceAccount
            └── CredentialEnvelope (interno e inacessível ao cliente)
```

## Developer Experience desejada

### Backend

```typescript
import { createChameleonClient } from "@chameleon/backend";

const chameleon = createChameleonClient({
  secretKey: process.env.CHAMELEON_SECRET_KEY!,
});

const session = await chameleon.connectSessions.create({
  organizationId: "org_123",
  provider: "amazon",
  returnUrl: "https://app.example.com/integrations",
});
```

### Frontend

```tsx
<ChameleonProvider publishableKey={process.env.NEXT_PUBLIC_CHAMELEON_PUBLISHABLE_KEY!}>
  <ConnectMarketplaceButton connectSessionToken={token} />
</ChameleonProvider>
```

### Resultado público

```json
{
  "id": "conn_123",
  "provider": "amazon",
  "status": "CONNECTED",
  "account": {
    "id": "acct_123",
    "providerAccountId": "seller_123",
    "displayName": "Example Seller",
    "country": "US",
    "marketplaceIds": ["marketplace_us"]
  }
}
```

Nenhuma API ou SDK público retorna access token, refresh token, authorization code ou credencial da aplicação do marketplace.

## Marcos

1. **v0.1 — Platform Foundation:** aplicações, ambientes, chaves, APIs e hosted callback.
2. **v0.2 — Etsy Connect:** primeiro provider ponta a ponta via Backend SDK.
3. **v0.3 — Hosted Connect:** UI hospedada e SDK frontend mínimo.
4. **v0.4 — eBay:** validação da abstração multi-provider.
5. **v0.5 — Walmart Marketplace US.**
6. **v0.6 — Reliability e produção.**
7. **v0.7 — TikTok Shop US.**
8. **v0.8 — Amazon US SP-API.**
9. **v0.9 — Temu US**, condicionada à API oficial e aprovação.
10. **Futuro:** React avançado, webhooks de marketplaces e Universal Marketplace API.

## Convenções

- Status: `[ ]` pendente, `[-]` bloqueado externamente, `[x]` concluído.
- Prioridade: `P0` bloqueia o marco; `P1` é necessária para o release; `P2` é posterior.
- Tamanho: `S` até 1 dia; `M` de 1 a 3 dias; `L` precisa ser refinado.
- Testes reais são opt-in e nunca rodam na CI padrão.
- Toda API mutável suporta idempotência quando houver risco de repetição.

---

## Epic 0 — Arquitetura e contratos

### [ ] CHM-001 — Registrar arquitetura hosted-first

**Prioridade/Tamanho:** P0 / M  
**Dependências:** nenhuma

**Entrega:** ADR definindo Frontend API, Backend API, Hosted Connect, SDKs e provider runtime interno.

**Critérios de aceite:**

- Declara que SDK público não acessa APIs dos marketplaces diretamente.
- OAuth callbacks e seller credentials pertencem à plataforma.
- Define limites de cada componente e comunicação entre eles.
- Separa explicitamente control plane, connection orchestration e provider layer.

### [ ] CHM-002 — Modelar tenancy e isolamento de ambientes

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-001

**Entrega:** modelo `Application → Environment → Organization → Connection`.

**Critérios de aceite:**

- Test e live não compartilham chaves, dados, webhooks ou credenciais.
- IDs externos do cliente têm escopo por environment.
- Toda query interna exige `environmentId`.
- Uma organization suporta várias contas por provider.

### [ ] CHM-003 — Definir recursos e API pública v1

**Prioridade/Tamanho:** P0 / L  
**Dependências:** CHM-002

**Entrega:** OpenAPI inicial para applications, organizations, connect sessions, connections e webhook endpoints.

**Critérios de aceite:**

- Rotas públicas não expõem credential resources.
- Paginação, filtros, erros e idempotency keys têm formato consistente.
- Todos os objetos possuem IDs opacos, timestamps e environment.
- Contrato permite gerar os tipos do Backend SDK.

### [ ] CHM-004 — Definir Frontend API e Connect Session

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-003

**Entrega:** contrato do token efêmero que autoriza uma única jornada de conexão.

**Critérios de aceite:**

- Publishable Key sozinha não cria conexão para qualquer organization.
- Token é curto, limitado por provider/organization/return URL e single-use quando aplicável.
- Frontend API não aceita Secret Key.
- Claims e validação server-side são documentadas.

### [ ] CHM-005 — Criar threat model da plataforma

**Prioridade/Tamanho:** P0 / L  
**Dependências:** CHM-001 a CHM-004

**Entrega:** threat model para keys, OAuth, callbacks, token vault, tenants, webhooks, dashboard e supply chain.

**Critérios de aceite:**

- Cobre replay, CSRF, SSRF, open redirect, callback injection e confused deputy.
- Define rotação, redaction, TTL, auditoria e least privilege.
- Cada mitigação necessária possui ticket associado.

---

## Epic 1 — Repositório e fundação

### [ ] CHM-010 — Inicializar monorepo TypeScript

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-001

**Entrega:** workspace com apps e packages separados.

**Estrutura inicial:**

```text
apps/
  api/
  connect/
  dashboard/
packages/
  backend/
  react/
  api-types/
  provider-core/
  providers/
  config/
```

**Critérios de aceite:**

- Packages internos não vazam nos exports dos SDKs públicos.
- Build, lint, typecheck e testes funcionam na raiz.
- Versões mínimas de Node.js e TypeScript estão declaradas.

### [ ] CHM-011 — Configurar testes e quality gates

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-010

**Entrega:** unit, integration e contract test layers.

**Critérios de aceite:**

- CI executa install limpo, lint, typecheck, testes e build.
- Testes de providers não acessam rede por padrão.
- Coverage ignora código gerado e artefatos.

### [ ] CHM-012 — Configurar gestão de secrets e ambientes

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-005, CHM-010

**Entrega:** configuração validada para local, test, staging e production.

**Critérios de aceite:**

- Segredos não são commitados nem incluídos em imagens/artefatos.
- Produção usa secret manager/KMS compatível.
- Startup falha cedo sem imprimir valores sensíveis.

### [ ] CHM-013 — Configurar migrations e banco de dados

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-010

**Entrega:** PostgreSQL, migration tooling e estratégia transacional.

**Critérios de aceite:**

- Migrations têm rollback/forward-fix documentado.
- Testes usam banco isolado e descartável.
- Nenhum ORM model é exposto nos SDKs.

### [ ] CHM-014 — Gerar tipos/clients a partir do OpenAPI

**Prioridade/Tamanho:** P1 / M  
**Dependências:** CHM-003, CHM-010

**Entrega:** pipeline de geração com validação de breaking changes.

**Critérios de aceite:**

- Artefatos são determinísticos.
- CI detecta contrato desatualizado.
- Código gerado é encapsulado por APIs ergonômicas do SDK.

---

## Epic 2 — Applications, environments e API keys

### [ ] CHM-020 — Persistir Application e Environment

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-002, CHM-013

**Entrega:** schema e repositories para aplicações e ambientes test/live.

**Critérios de aceite:**

- Cada environment possui slug/ID estável e configuração isolada.
- Produção não consulta dados de teste.
- Exclusão respeita retenção e recursos dependentes.

### [ ] CHM-021 — Emitir Publishable Keys

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-020

**Entrega:** chaves com prefixos reconhecíveis para test/live e metadata mínima pública.

**Critérios de aceite:**

- Publishable Key identifica environment, mas não concede acesso administrativo.
- Rotação/revogação é suportada.
- Chave pode ser exposta no frontend sem revelar segredo.

### [ ] CHM-022 — Emitir e armazenar Secret Keys

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-020, CHM-005

**Entrega:** Secret Keys test/live exibidas uma vez e armazenadas com proteção adequada.

**Critérios de aceite:**

- Prefixos distinguem test/live.
- Valor completo não pode ser recuperado depois da criação.
- Suporta múltiplas chaves, nome, last-used, rotação e revogação.
- Logs e traces nunca incluem a chave.

### [ ] CHM-023 — Autenticar Backend API por Secret Key

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-022

**Entrega:** middleware que resolve application/environment e aplica autorização.

**Critérios de aceite:**

- Key inválida/revogada retorna erro consistente.
- Toda request recebe request ID e environment context.
- Comparação e lookup não expõem timing/metadata indevida.

### [ ] CHM-024 — Resolver Frontend API por Publishable Key

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-021

**Entrega:** middleware público com políticas estritas por endpoint.

**Critérios de aceite:**

- Não concede acesso à Backend API.
- Valida allowed origins quando aplicável.
- Retorna apenas configuração frontend segura.

### [ ] CHM-025 — Gerenciar allowed origins e redirect URLs

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-020, CHM-005

**Entrega:** cadastro e validação exata de origens/URLs por environment.

**Critérios de aceite:**

- Bloqueia wildcards inseguros e open redirects.
- Normalização de URL tem testes de bypass.
- Localhost é permitido somente pela política de desenvolvimento.

### [ ] CHM-026 — Aplicar rate limits às APIs públicas

**Prioridade/Tamanho:** P1 / M  
**Dependências:** CHM-023, CHM-024

**Entrega:** limites por environment, key, IP e rota quando apropriado.

**Critérios de aceite:**

- Respostas fornecem retry hints seguros.
- Limites não permitem inferir existência de outro tenant.
- Configuração suporta planos futuros sem acoplá-los ao SDK.

---

## Epic 3 — Domínio, persistência e credential vault

### [ ] CHM-030 — Modelar Organization, Connection e Account

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-002, CHM-013

**Entrega:** entidades normalizadas e constraints multi-tenant.

**Critérios de aceite:**

- Organization aceita `externalId` fornecido pelo cliente.
- Uma organization pode possuir várias accounts do mesmo provider.
- Provider account ID é distinto do ID Chameleon.
- Tokens não aparecem nas entidades públicas.

### [ ] CHM-031 — Implementar máquina de estados da conexão

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-030

**Entrega:** transições entre `PENDING`, `CONNECTED`, `REAUTHORIZATION_REQUIRED`, `DISCONNECTED` e `FAILED`.

**Critérios de aceite:**

- Transições inválidas são rejeitadas.
- Histórico registra causa segura, ator e timestamp.
- Falha parcial não produz `CONNECTED` sem account/credentials válidas.

### [ ] CHM-032 — Criar credential vault

**Prioridade/Tamanho:** P0 / L  
**Dependências:** CHM-005, CHM-013, CHM-030

**Entrega:** armazenamento criptografado de provider app credentials e seller credentials.

**Critérios de aceite:**

- Usa envelope encryption com KMS e key version.
- Associated data inclui environment, connection e provider.
- Só workers/services autorizados podem descriptografar.
- Banco, logs, traces e backups não contêm plaintext.

### [ ] CHM-033 — Implementar rotação e auditoria do vault

**Prioridade/Tamanho:** P1 / L  
**Dependências:** CHM-032

**Entrega:** re-encryption, key rotation e audit trail de acesso.

**Critérios de aceite:**

- Rotação não exige desconectar sellers.
- Acesso ao plaintext gera evento de auditoria sem o valor.
- Falhas podem ser retomadas com segurança.

### [ ] CHM-034 — Persistir OAuth transactions

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-030

**Entrega:** state, PKCE, nonce, redirect, provider e TTL server-side.

**Critérios de aceite:**

- State é CSPRNG, single-use e consumido atomicamente.
- Transação pertence a environment, organization e connection.
- Dados expirados são eliminados por job de retenção.

### [ ] CHM-035 — Implementar idempotência da Backend API

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-013, CHM-023

**Entrega:** suporte a idempotency key em criação, disconnect e operações mutáveis críticas.

**Critérios de aceite:**

- Repetição retorna o mesmo resultado lógico.
- Key tem escopo por environment e operação.
- Payload conflitante com a mesma key é rejeitado.

### [ ] CHM-036 — Implementar lock distribuído por connection

**Prioridade/Tamanho:** P1 / M  
**Dependências:** CHM-030

**Entrega:** exclusão mútua para refresh, callback e reconnect concorrentes.

**Critérios de aceite:**

- Lock tem timeout e fencing/estratégia contra owner morto.
- Testes provam que só um refresh efetivo ocorre.
- Falha do lock não corrompe credentials.

### [ ] CHM-037 — Implementar retenção e deleção

**Prioridade/Tamanho:** P1 / M  
**Dependências:** CHM-030 a CHM-034

**Entrega:** políticas para OAuth transactions, credentials, accounts, logs e backups.

**Critérios de aceite:**

- Disconnect e exclusão têm semântica documentada.
- Dados sensíveis temporários têm TTL mínimo.
- Jobs são idempotentes e auditáveis.

---

## Epic 4 — Provider runtime interno

### [ ] CHM-040 — Definir catálogo central de providers

**Prioridade/Tamanho:** P0 / S  
**Dependências:** CHM-010

**Entrega:** IDs `etsy`, `ebay`, `walmart`, `tiktok_shop`, `amazon` e `temu`, com status por environment.

**Critérios de aceite:**

- Provider não implementado nunca aparece como disponível.
- Catálogo não é duplicado entre API, dashboard e SDKs.
- Display metadata pública não inclui configuração sensível.

### [ ] CHM-041 — Definir contrato interno `MarketplaceProvider`

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-030, CHM-034, CHM-040

**Entrega:** contrato para authorization, exchange, refresh, account, validation, revocation e capabilities.

**Critérios de aceite:**

- Entradas usam referências seguras às credentials, não secrets públicos.
- Provider-specific metadata não contamina domínio genérico.
- Operações opcionais são capabilities, não branches no orchestrator.

### [ ] CHM-042 — Implementar Provider Registry

**Prioridade/Tamanho:** P0 / S  
**Dependências:** CHM-041

**Entrega:** registro, lookup e health/availability de providers.

**Critérios de aceite:**

- Impede IDs duplicados.
- Provider indisponível retorna erro público acionável.
- Adicionar provider não exige editar Connection Orchestrator.

### [ ] CHM-043 — Criar HTTP runtime para providers

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-005, CHM-041

**Entrega:** HTTP client interno com timeout, abort, retry hooks e redaction.

**Critérios de aceite:**

- Respostas têm tamanho máximo e parsing seguro.
- Authorization headers e bodies sensíveis nunca são logados.
- Testes usam transport fake sem rede.

### [ ] CHM-044 — Criar hierarquia de erros normalizados

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-041

**Entrega:** erros internos e públicos para OAuth, credentials, permissions, throttling, provider e storage.

**Critérios de aceite:**

- Erro público contém code, provider, retryable e request ID.
- Cause sensível permanece somente em observabilidade restrita e redigida.
- SDK mapeia o mesmo formato para classes tipadas.

### [ ] CHM-045 — Criar contract test suite de providers

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-041 a CHM-044

**Entrega:** testes reutilizáveis de authorization, callback, refresh, account, erros e capabilities.

**Critérios de aceite:**

- Todo provider entregue precisa passar na suíte.
- Casos não suportados são declarados por capability.
- Nenhum teste padrão acessa a internet.

---

## Epic 5 — Hosted Connection Orchestrator

### [ ] CHM-050 — Criar Connect Session pela Backend API

**Prioridade/Tamanho:** P0 / L  
**Dependências:** CHM-004, CHM-023, CHM-030, CHM-035

**Entrega:** endpoint autenticado que cria organization quando necessário, connection pendente e token frontend efêmero.

**Critérios de aceite:**

- Aceita external organization ID, provider e return URL permitida.
- Retorna `connectSessionToken`, `connectUrl`, expiração e connection ID.
- Idempotency key evita sessões/conexões duplicadas.
- Secret Key nunca é propagada ao frontend.

### [ ] CHM-051 — Iniciar authorization pelo Hosted Connect

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-024, CHM-034, CHM-042, CHM-050

**Entrega:** Frontend API valida a Connect Session, cria OAuth transaction e redireciona ao provider.

**Critérios de aceite:**

- Provider e connection não podem ser trocados pelo browser.
- Gera state/PKCE conforme capabilities.
- Só redirect URLs cadastradas são aceitas.

### [ ] CHM-052 — Hospedar callback OAuth por provider

**Prioridade/Tamanho:** P0 / L  
**Dependências:** CHM-034, CHM-041, CHM-051

**Entrega:** callback em domínio Chameleon que valida state e executa code exchange.

**Critérios de aceite:**

- State é consumido atomicamente antes de finalizar.
- Callback duplicado é idempotente.
- Negação, state inválido e provider error geram estados consistentes.
- Authorization code nunca é enviado para a aplicação do cliente.

### [ ] CHM-053 — Finalizar account e connection

**Prioridade/Tamanho:** P0 / L  
**Dependências:** CHM-032, CHM-052

**Entrega:** criptografa credentials, obtém identidade e persiste account/connection transacionalmente.

**Critérios de aceite:**

- Connection só vira `CONNECTED` com credentials e account válidas.
- Mesmo provider account na mesma organization não duplica silenciosamente.
- Evento de conclusão é produzido após commit.

### [ ] CHM-054 — Consultar e listar connections

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-023, CHM-030

**Entrega:** Backend API para get/list com filtros e paginação.

**Critérios de aceite:**

- Isolamento por environment é obrigatório.
- Retorna account normalizada e status, nunca credentials.
- SDK types representam todos os estados possíveis.

### [ ] CHM-055 — Implementar disconnect e reconnect

**Prioridade/Tamanho:** P0 / L  
**Dependências:** CHM-031, CHM-035, CHM-053

**Entrega:** endpoints idempotentes e jornadas Hosted Connect correspondentes.

**Critérios de aceite:**

- Reconnect gera nova transaction/state.
- Revoga no provider quando suportado.
- Disconnect bloqueia refresh e futuras execuções.
- Eventos são produzidos depois de transição persistida.

### [ ] CHM-056 — Implementar refresh worker

**Prioridade/Tamanho:** P1 / L  
**Dependências:** CHM-032, CHM-036, CHM-041

**Entrega:** refresh preventivo/on-demand com fila e lock.

**Critérios de aceite:**

- Rotação de refresh token é persistida atomicamente.
- Falha definitiva marca `REAUTHORIZATION_REQUIRED`.
- Backoff, jitter e dead-letter policy são documentados.

---

## Epic 6 — Backend API e `@chameleon/backend`

### [ ] CHM-060 — Implementar Backend API v1

**Prioridade/Tamanho:** P0 / L  
**Dependências:** CHM-023, CHM-050, CHM-054, CHM-055

**Entrega:** rotas versionadas de organizations, connect sessions e connections.

**Critérios de aceite:**

- Implementação corresponde ao OpenAPI.
- Erros possuem shape estável e request ID.
- CORS não habilita acesso browser com Secret Key.

### [ ] CHM-061 — Criar `createChameleonClient()`

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-014, CHM-060

**Entrega:** client server-side autenticado por Secret Key.

**Critérios de aceite:**

- API base pode ser sobrescrita apenas para test/self-hosted development.
- Secret Key é validada sem aparecer em erros.
- Client suporta timeout, AbortSignal, user agent e request ID.

### [ ] CHM-062 — Implementar resources do Backend SDK

**Prioridade/Tamanho:** P0 / L  
**Dependências:** CHM-061

**Entrega:** `organizations`, `connectSessions` e `connections` com métodos tipados.

**Critérios de aceite:**

- Métodos espelham recursos, não endpoints crus.
- Paginação e erros são ergonômicos.
- Nenhum método aceita/retorna token de marketplace.

### [ ] CHM-063 — Implementar retry e idempotência no SDK

**Prioridade/Tamanho:** P1 / M  
**Dependências:** CHM-061, CHM-062

**Entrega:** retries seguros, idempotency keys e telemetria do SDK.

**Critérios de aceite:**

- Não repete operação insegura sem idempotency key.
- Respeita Retry-After e AbortSignal.
- Telemetria não contém Secret Key nem dados sensíveis.

### [ ] CHM-064 — Publicar prerelease do Backend SDK

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-061 a CHM-063

**Entrega:** pacote npm com JS, declarations, source maps, README e changelog.

**Critérios de aceite:**

- Tarball é instalado em projeto externo de smoke test.
- Exports funcionam nos módulos suportados.
- Pacote não contém código interno dos providers nem secrets.

---

## Epic 7 — Etsy Connect (primeiro provider)

### [ ] CHM-070 — Validar requisitos oficiais Etsy

**Prioridade/Tamanho:** P0 / S  
**Dependências:** CHM-041

**Entrega:** endpoints, scopes, PKCE, refresh, identity e revocation atuais documentados com links/data.

### [ ] CHM-071 — Configurar Etsy no credential vault

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-032, CHM-070

**Entrega:** provider app config por environment, acessível somente ao runtime interno.

### [ ] CHM-072 — Implementar authorization Etsy com PKCE

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-034, CHM-071

**Entrega:** authorization URL e transaction server-side.

### [ ] CHM-073 — Implementar exchange e persistência Etsy

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-052, CHM-071, CHM-072

**Entrega:** code exchange, credential normalization e vault.

### [ ] CHM-074 — Recuperar e normalizar shop Etsy

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-073

**Entrega:** seller/shop identity mapeada para `MarketplaceAccount`.

### [ ] CHM-075 — Implementar refresh, revocation e erros Etsy

**Prioridade/Tamanho:** P0 / L  
**Dependências:** CHM-073

**Entrega:** lifecycle e error mapper completos.

### [ ] CHM-076 — Testar Etsy ponta a ponta

**Prioridade/Tamanho:** P0 / L  
**Dependências:** CHM-045, CHM-050 a CHM-056, CHM-072 a CHM-075

**Entrega:** contract/unit/integration tests do Backend SDK até provider mockado.

### [-] CHM-077 — Validar Etsy real

**Prioridade/Tamanho:** P0 / S  
**Dependências:** CHM-076  
**Bloqueio esperado:** aplicação e shop Etsy de teste

**Entrega:** Hosted Connect real conecta shop e Backend SDK consulta a connection sem expor tokens.

---

## Epic 8 — Hosted Connect e frontend SDK

### [ ] CHM-080 — Criar aplicação Hosted Connect

**Prioridade/Tamanho:** P0 / L  
**Dependências:** CHM-024, CHM-050, CHM-051

**Entrega:** página hospedada que apresenta provider, consentimento, loading, sucesso e erro.

**Critérios de aceite:**

- Token da Connect Session é validado server-side.
- Não processa Secret Key ou marketplace credentials no browser.
- Return URL é previamente permitida e não vem livremente da query string.

### [ ] CHM-081 — Criar `@chameleon/connect-js`

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-004, CHM-024, CHM-080

**Entrega:** client frontend mínimo para abrir Hosted Connect e receber resultado.

**Critérios de aceite:**

- Inicializa com Publishable Key e Connect Session Token.
- Eventos `opened`, `connected`, `exited` e `error` têm payload seguro.
- Não contém Secret Key nem lógica de provider.

### [ ] CHM-082 — Validar origins, popup e postMessage

**Prioridade/Tamanho:** P0 / L  
**Dependências:** CHM-025, CHM-080, CHM-081

**Entrega:** comunicação segura iframe/popup/parent.

**Critérios de aceite:**

- `targetOrigin` nunca usa wildcard em produção.
- Mensagens têm nonce/session binding e schema validation.
- CSP, frame ancestors e popup blockers têm comportamento documentado.

### [ ] CHM-083 — Implementar acessibilidade e customização básica

**Prioridade/Tamanho:** P1 / M  
**Dependências:** CHM-080

**Entrega:** hosted UI acessível, responsiva e tematizável por configuração segura.

**Critérios de aceite:**

- Navegação por teclado e leitores de tela cobrem a jornada.
- Branding não permite HTML/CSS arbitrário.
- Estados de erro oferecem recovery claro.

### [ ] CHM-084 — Criar `@chameleon/react`

**Prioridade/Tamanho:** P1 / L  
**Dependências:** CHM-081, Etsy e eBay estáveis

**Entrega:** `ChameleonProvider`, `ConnectMarketplaceButton` e hooks.

**Critérios de aceite:**

- React SDK envolve `connect-js` e não duplica protocolo.
- Suporta SSR sem acessar `window` durante render server-side.
- Bundle não contém código server-side ou secrets.

---

## Epic 9 — Webhooks do Chameleon para clientes

### [ ] CHM-090 — Definir catálogo de eventos

**Prioridade/Tamanho:** P1 / M  
**Dependências:** CHM-031, CHM-053

**Entrega:** `connection.created`, `connection.connected`, `connection.reauthorization_required`, `connection.disconnected` e `connection.failed`.

### [ ] CHM-091 — Gerenciar webhook endpoints e signing secrets

**Prioridade/Tamanho:** P1 / M  
**Dependências:** CHM-020, CHM-022

**Entrega:** endpoints por environment com secret exibido uma vez, rotação e status.

### [ ] CHM-092 — Implementar outbox e delivery worker

**Prioridade/Tamanho:** P1 / L  
**Dependências:** CHM-053, CHM-091

**Entrega:** entrega assinada, retries, jitter e dead-letter.

**Critérios de aceite:**

- Evento só é publicado depois do commit.
- Delivery é at-least-once e inclui event ID para deduplicação.
- SSRF protections bloqueiam destinos inseguros.

### [ ] CHM-093 — Fornecer verificação de assinatura no Backend SDK

**Prioridade/Tamanho:** P1 / M  
**Dependências:** CHM-064, CHM-092

**Entrega:** helper para verificar raw body, timestamp e assinatura.

---

## Epic 10 — eBay

### [ ] CHM-100 — Pesquisar OAuth e identity eBay atuais

**Prioridade/Tamanho:** P0 / S  
**Dependências:** CHM-076

### [ ] CHM-101 — Configurar `EbayProvider` no vault/runtime

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-100

### [ ] CHM-102 — Implementar authorization, scopes e callback eBay

**Prioridade/Tamanho:** P0 / L  
**Dependências:** CHM-101

### [ ] CHM-103 — Implementar exchange e refresh eBay

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-102

### [ ] CHM-104 — Normalizar seller identity eBay

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-103

### [ ] CHM-105 — Normalizar erros, rate limits e revocation eBay

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-101

### [ ] CHM-106 — Executar contract e integration tests eBay

**Prioridade/Tamanho:** P0 / L  
**Dependências:** CHM-102 a CHM-105

### [ ] CHM-107 — Auditar abstração após eBay

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-106

**Critérios de aceite:**

- Orchestrator, APIs e SDKs não têm condicionais Etsy/eBay.
- Adicionar eBay não alterou shapes públicos específicos por provider.
- Diferenças legítimas permanecem em capabilities/adapters.

### [-] CHM-108 — Validar eBay real

**Prioridade/Tamanho:** P1 / S  
**Dependências:** CHM-106  
**Bloqueio esperado:** aplicação e seller eBay aprovados

---

## Epic 11 — Walmart Marketplace US

### [ ] CHM-110 — Pesquisar autenticação Walmart vigente

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-107

### [ ] CHM-111 — Configurar `WalmartProvider` e capabilities

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-110

### [ ] CHM-112 — Implementar authorization/lifecycle Walmart

**Prioridade/Tamanho:** P0 / L  
**Dependências:** CHM-111

### [ ] CHM-113 — Recuperar e normalizar seller Walmart US

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-112

### [ ] CHM-114 — Normalizar erros e throttling Walmart

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-111

### [ ] CHM-115 — Testar e documentar Walmart sandbox

**Prioridade/Tamanho:** P0 / L  
**Dependências:** CHM-112 a CHM-114

### [-] CHM-116 — Validar Walmart real

**Prioridade/Tamanho:** P1 / S  
**Dependências:** CHM-115  
**Bloqueio esperado:** aprovação Solution Provider e seller US

---

## Epic 12 — Reliability, observabilidade e produção

### [ ] CHM-120 — Padronizar timeouts, retries e circuit breaking

**Prioridade/Tamanho:** P0 / L  
**Dependências:** CHM-043, dois providers funcionais

### [ ] CHM-121 — Implementar logs, metrics e traces seguros

**Prioridade/Tamanho:** P0 / L  
**Dependências:** CHM-005

**Critérios de aceite:**

- Correlation IDs ligam SDK, API, job e provider request.
- Tokens, codes, cookies, keys e PII sensível são redigidos.
- Métricas evitam cardinalidade por seller/account.

### [ ] CHM-122 — Criar audit log de ações sensíveis

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-033, CHM-121

### [ ] CHM-123 — Implementar health/readiness e provider status

**Prioridade/Tamanho:** P0 / M  
**Dependências:** CHM-042, CHM-121

### [ ] CHM-124 — Executar security review e dependency audit

**Prioridade/Tamanho:** P0 / L  
**Dependências:** MVP completo

### [ ] CHM-125 — Testar carga, concorrência e recovery

**Prioridade/Tamanho:** P0 / L  
**Dependências:** CHM-036, CHM-056, CHM-092

### [ ] CHM-126 — Definir SLOs, alertas e runbooks

**Prioridade/Tamanho:** P1 / L  
**Dependências:** CHM-121, CHM-123, CHM-125

---

## Epic 13 — TikTok Shop US

### [ ] CHM-130 — Pesquisar seller authorization TikTok Shop US

**Prioridade/Tamanho:** P2 / M  
**Dependências:** CHM-120

### [ ] CHM-131 — Configurar `TikTokShopProvider`

**Prioridade/Tamanho:** P2 / M  
**Dependências:** CHM-130

### [ ] CHM-132 — Implementar authorization, callback e signing

**Prioridade/Tamanho:** P2 / L  
**Dependências:** CHM-131

### [ ] CHM-133 — Implementar exchange e refresh TikTok

**Prioridade/Tamanho:** P2 / M  
**Dependências:** CHM-132

### [ ] CHM-134 — Normalizar shop identity TikTok US

**Prioridade/Tamanho:** P2 / M  
**Dependências:** CHM-133

### [ ] CHM-135 — Implementar errors/rate limits e testes

**Prioridade/Tamanho:** P2 / L  
**Dependências:** CHM-132 a CHM-134

### [-] CHM-136 — Validar TikTok Shop US real

**Prioridade/Tamanho:** P2 / S  
**Dependências:** CHM-135  
**Bloqueio esperado:** partner app e seller US aprovados

---

## Epic 14 — Amazon US SP-API

Backlog detalhado e alinhado ao modelo hosted-first: [TASKS-AMAZON.md](./TASKS-AMAZON.md).

### [ ] AMZ-001 — Pesquisar e modelar Amazon SP-API US

### [ ] AMZ-002 — Configurar Amazon/LWA no vault interno

### [ ] AMZ-003 — Implementar seller authorization e hosted callback

### [ ] AMZ-004 — Implementar exchange/refresh LWA

### [ ] AMZ-005 — Recuperar seller identity e marketplace IDs

### [ ] AMZ-006 — Isolar roles e Restricted Data Token

### [ ] AMZ-007 — Implementar throttling, erros e reconnect

### [ ] AMZ-008 — Executar testes unitários, contract e integração

### [ ] AMZ-009 — Documentar setup e comportamento público

### [-] AMZ-010 — Validar seller Amazon US real

**Bloqueio esperado:** aplicação SP-API aprovada, roles e seller US

---

## Epic 15 — Temu US

### [ ] CHM-150 — Pesquisar disponibilidade da API oficial Temu US

**Prioridade/Tamanho:** P2 / M  
**Dependências:** CHM-120

**Critérios de aceite:**

- Confirma se existe fluxo oficial para partners conectarem sellers US.
- Se não existir, documenta limitação e não usa scraping/browser automation/endpoints não oficiais.

### [ ] CHM-151 — Configurar `TemuProvider` se oficialmente suportado

### [ ] CHM-152 — Implementar authorization e callback Temu

### [ ] CHM-153 — Implementar credentials/signing/refresh Temu

### [ ] CHM-154 — Normalizar seller identity Temu US

### [ ] CHM-155 — Implementar errors/rate limits e testes

### [-] CHM-156 — Validar Temu US real

**Bloqueio esperado:** acesso partner oficial e seller US elegível

---

## Epic 16 — Dashboard e Developer Experience

### [ ] CHM-160 — Criar onboarding de Application

**Prioridade/Tamanho:** P1 / L  
**Dependências:** CHM-020 a CHM-025

**Entrega:** criação de app, ambientes test/live e visualização inicial das keys.

### [ ] CHM-161 — Gerenciar keys, origins e redirects

**Prioridade/Tamanho:** P1 / L  
**Dependências:** CHM-160

### [ ] CHM-162 — Gerenciar providers e status de configuração

**Prioridade/Tamanho:** P1 / M  
**Dependências:** CHM-040, CHM-160

### [ ] CHM-163 — Visualizar organizations e connections

**Prioridade/Tamanho:** P1 / L  
**Dependências:** CHM-054, CHM-160

**Critérios de aceite:**

- Nunca mostra access/refresh tokens.
- Ações sensíveis exigem confirmação e entram no audit log.

### [ ] CHM-164 — Gerenciar webhooks e delivery logs

**Prioridade/Tamanho:** P1 / L  
**Dependências:** CHM-091, CHM-092

### [ ] CHM-165 — Criar documentação e quickstarts

**Prioridade/Tamanho:** P0 / L  
**Dependências:** CHM-064, CHM-081

**Entrega:** quickstarts Backend SDK, Connect JS, React, webhooks e cada provider.

---

## Epic 17 — Universal Marketplace API futura

### [ ] CHM-170 — Definir executor interno por connection

**Prioridade/Tamanho:** P2 / M  
**Dependências:** três providers estáveis

### [ ] CHM-171 — Projetar capabilities de orders/products/inventory

**Prioridade/Tamanho:** P2 / L  
**Dependências:** CHM-170

### [ ] CHM-172 — Projetar recursos normalizados sem estabilizar prematuramente

**Prioridade/Tamanho:** P2 / L  
**Dependências:** CHM-171

---

## Definition of Done global

Um ticket só está concluído quando:

- implementação e contrato OpenAPI estão sincronizados;
- unit, integration, contract e type tests relevantes passam;
- isolamento entre applications/environments/organizations foi testado;
- Secret Keys e provider credentials permanecem exclusivamente server-side;
- tokens/codes/secrets não aparecem em APIs, SDK returns, logs, traces, fixtures ou snapshots;
- operação mutável crítica tem idempotência definida;
- mudança pública possui documentação, changelog e avaliação SemVer;
- provider novo passa nos contract tests sem adicionar lógica específica ao orchestrator/SDKs.

## Corte recomendado para o primeiro MVP

```text
CHM-001…CHM-005
    ↓
CHM-010…CHM-014
    ↓
CHM-020…CHM-025
    ↓
CHM-030…CHM-035
    ↓
CHM-040…CHM-045
    ↓
CHM-050…CHM-055
    ↓
CHM-060…CHM-064
    ↓
CHM-070…CHM-077
    ↓
CHM-080…CHM-082
```

O primeiro MVP termina quando um cliente instala `@chameleon/backend`, cria uma Connect Session com sua Secret Key, direciona o usuário ao Hosted Connect e consulta uma connection Etsy concluída sem manipular qualquer credencial Etsy.
