# Backlog — Amazon US SP-API no Chameleon

Este backlog implementa Amazon como provider interno da plataforma hosted-first do Chameleon. O Developer Experience segue o estilo Clerk: o cliente instala SDKs e usa chaves Chameleon; credenciais Amazon, callbacks, tokens e refresh permanecem na infraestrutura Chameleon.

## Experiência pública esperada

### Backend do cliente

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

### Frontend do cliente

```tsx
<ConnectMarketplaceButton connectSessionToken={session.connectSessionToken} />
```

### Fluxo interno

```text
Customer Backend SDK
        │ Secret Key
        ▼
Chameleon Backend API ── creates ──► Connect Session
                                         │
Customer Frontend ── Publishable Key ────┘
        │
        ▼
Chameleon Hosted Connect
        │
        ▼
Amazon Seller Authorization
        │
        ▼
Chameleon Hosted Callback
        │
        ├── validates state
        ├── exchanges authorization code
        ├── stores refresh token in Credential Vault
        ├── resolves seller/marketplace identity
        └── emits connection.connected
```

## Regras de arquitetura

- O cliente utiliza somente `pk_test/pk_live` e `sk_test/sk_live` do Chameleon.
- Amazon application credentials e LWA secrets nunca entram no SDK público.
- O callback registrado na Amazon pertence a um domínio Chameleon.
- Authorization codes e LWA tokens nunca são enviados à return URL do cliente.
- `AmazonProvider` roda apenas em serviços internos.
- Particularidades de LWA, SP-API, roles, regions, marketplace IDs e RDT não entram no domínio genérico.
- Test e live usam aplicações/configurações/credentials isoladas.
- BYOC de aplicação Amazon fica fora do MVP.

## Pré-requisitos da plataforma

- Backend API autenticada por Secret Key.
- Frontend API resolvida por Publishable Key.
- Connect Sessions efêmeras.
- Hosted Connect e callback hospedado.
- Organization, Connection e MarketplaceAccount persistidos.
- Credential Vault com KMS/envelope encryption.
- OAuth transaction store single-use.
- Distributed lock, queue, retry e observabilidade.
- Provider Registry e contract tests.
- Etsy e eBay já validaram a abstração.

## Convenções

- Status: `[ ]` pendente, `[-]` bloqueado externamente, `[x]` concluído.
- `P0`: bloqueia Amazon Connect; `P1`: necessária para produção; `P2`: capability posterior.
- `S`: até 1 dia; `M`: 1–3 dias; `L`: precisa de refinamento.

## Implementação atual

Implementado e validado localmente com transportes mockados: `AMZ-001`, `AMZ-003`, `AMZ-011` a `AMZ-013`, `AMZ-020` a `AMZ-021`, `AMZ-023`, `AMZ-030` a `AMZ-032`, `AMZ-040` a `AMZ-042`, `AMZ-050`, `AMZ-052`, `AMZ-070`, `AMZ-080`, `AMZ-082` e `AMZ-083`.

O checkpoint inclui provider, Hosted Connect handler, callback em duas etapas, LWA, vault AES-256-GCM, assinatura AWS SigV4, Sellers API, backend SDK e testes. Os itens restantes exigem infraestrutura de produção (KMS/DB/outbox/locks/worker/UI/webhook), aprovação Amazon, ou capacidades ainda fora do MVP.

---

## Epic A — Pesquisa, aprovação e arquitetura Amazon

### [x] AMZ-001 — Pesquisar seller authorization e LWA vigentes

**Prioridade/Tamanho:** P0 / M  
**Dependências:** nenhuma

**Entrega:** documento versionado do fluxo oficial para uma aplicação pública conectar sellers Amazon US.

**Critérios de aceite:**

- Usa somente documentação oficial atual, com links e data de consulta.
- Registra endpoints, parâmetros, callback, tokens, expirações e refresh.
- Diferencia aplicação pública, privada, draft/test e produção quando aplicável.
- Identifica etapas bloqueadas por aprovação sem bloquear mocks e implementação interna.

### [ ] AMZ-002 — Documentar processo de aplicação e aprovação SP-API

**Prioridade/Tamanho:** P0 / M  
**Dependências:** AMZ-001

**Entrega:** checklist operacional para a aplicação Chameleon na Amazon.

**Critérios de aceite:**

- Lista cadastro, perfil, use case, roles, URLs e políticas exigidas oficialmente.
- Separa ações de engenharia, segurança, jurídico/compliance e operação.
- Não orienta clientes Chameleon a criar aplicações Amazon no MVP.
- Marca dependências externas e lead times sem inventar prazos.

### [x] AMZ-003 — Mapear regiões e marketplace IDs

**Prioridade/Tamanho:** P0 / S  
**Dependências:** AMZ-001

**Entrega:** configuração interna tipada para Amazon US.

**Critérios de aceite:**

- Região de endpoint e marketplace ID são conceitos distintos.
- Configuração US fica centralizada e validada.
- Adicionar Canadá/México futuramente não exige alterar APIs públicas.

### [ ] AMZ-004 — Mapear roles e permissões mínimas

**Prioridade/Tamanho:** P0 / M  
**Dependências:** AMZ-001, AMZ-002

**Entrega:** matriz de capability → role/permissão.

**Critérios de aceite:**

- Conexão e seller identity solicitam somente o mínimo necessário.
- Orders, finance e dados restritos não entram no consentimento do MVP.
- Falta de role tem erro distinto de credencial inválida.

### [ ] AMZ-005 — Atualizar threat model para Amazon

**Prioridade/Tamanho:** P0 / M  
**Dependências:** AMZ-001 a AMZ-004

**Entrega:** ameaças e controles para application secret, callback, refresh token LWA, seller ID e RDT.

**Critérios de aceite:**

- Cobre CSRF/replay, confused deputy, tenant mix-up e callback manipulation.
- Define acesso mínimo ao plaintext e redaction obrigatória.
- Revisa return URLs para impedir authorization code leakage/open redirect.

---

## Epic B — Configuração interna e provider

### [ ] AMZ-010 — Armazenar configuração da aplicação Amazon no vault

**Prioridade/Tamanho:** P0 / M  
**Dependências:** AMZ-002, credential vault pronto

**Entrega:** application ID, LWA client credentials e demais secrets por environment.

**Critérios de aceite:**

- Test/staging/live são isolados.
- Plaintext só é acessível ao runtime Amazon autorizado.
- Alterações geram audit event.
- Nenhuma configuração Amazon é retornada pelo dashboard/API/SDK público.

### [x] AMZ-011 — Implementar validação de configuração Amazon

**Prioridade/Tamanho:** P0 / S  
**Dependências:** AMZ-003, AMZ-010

**Entrega:** parser interno que falha cedo em combinações inválidas.

**Critérios de aceite:**

- Valida ambiente, região, callback e campos oficiais necessários.
- Erros não exibem valores sensíveis.
- Provider indisponível não aparece como habilitado no Hosted Connect.

### [x] AMZ-012 — Criar `AmazonProvider`

**Prioridade/Tamanho:** P0 / M  
**Dependências:** AMZ-011, contrato `MarketplaceProvider`

**Entrega:** adapter registrado no runtime interno.

**Critérios de aceite:**

- ID público do provider é `amazon`.
- Backend SDK e orchestrator não recebem branches Amazon.
- Capabilities opcionais são declaradas pelo provider.
- Módulo não é empacotado em `@chameleon/backend` ou `@chameleon/react`.

### [x] AMZ-013 — Criar HTTP clients internos LWA e SP-API

**Prioridade/Tamanho:** P0 / M  
**Dependências:** AMZ-012

**Entrega:** clients separados usando o HTTP runtime comum.

**Critérios de aceite:**

- Suportam timeout, AbortSignal, request ID, retry hooks e transport fake.
- Authorization headers, client secret e bodies sensíveis são redigidos.
- Respostas têm validação de schema e limite de tamanho.

---

## Epic C — Hosted seller authorization

### [x] AMZ-020 — Habilitar Amazon em Connect Sessions

**Prioridade/Tamanho:** P0 / M  
**Dependências:** AMZ-012, Connect Session API pronta

**Entrega:** `provider: "amazon"` aceito pela Backend API/SDK quando o environment estiver configurado.

**Critérios de aceite:**

- Customer Secret Key identifica application/environment.
- Organization, return URL e provider ficam vinculados ao token efêmero.
- Session expira e não contém credential Amazon.
- Provider desabilitado retorna erro acionável.

### [x] AMZ-021 — Gerar seller authorization URL

**Prioridade/Tamanho:** P0 / M  
**Dependências:** AMZ-013, AMZ-020

**Entrega:** `getAuthorizationUrl()` conforme fluxo oficial vigente.

**Critérios de aceite:**

- Usa callback Chameleon e application ID do environment correto.
- State CSPRNG referencia uma OAuth transaction server-side single-use.
- Browser não escolhe organization, connection ou callback livremente.
- URL tem testes de encoding e parâmetros.

### [ ] AMZ-022 — Exibir Amazon no Hosted Connect

**Prioridade/Tamanho:** P0 / S  
**Dependências:** AMZ-020, Hosted Connect pronto

**Entrega:** estado de confirmação/redirect Amazon na UI hospedada.

**Critérios de aceite:**

- Exibe ambiente, marketplace e organização de maneira segura.
- Loading, cancelamento e provider indisponível são tratados.
- UI não recebe Secret Key, LWA secret ou provider token.

### [x] AMZ-023 — Processar Hosted Callback Amazon

**Prioridade/Tamanho:** P0 / L  
**Dependências:** AMZ-021, callback orchestrator pronto

**Entrega:** parsing e validação dos parâmetros oficiais retornados pela Amazon.

**Critérios de aceite:**

- Valida e consome state atomicamente.
- Confere environment, provider, connection e transaction esperados.
- Trata consentimento negado/cancelado com status e erro seguros.
- Authorization code permanece somente no backend Chameleon.

### [ ] AMZ-024 — Garantir callback idempotente e transacional

**Prioridade/Tamanho:** P0 / M  
**Dependências:** AMZ-023, distributed lock/idempotency prontos

**Entrega:** proteção contra callback repetido, concorrente e falha parcial.

**Critérios de aceite:**

- State não pode ser consumido duas vezes.
- Não duplica connection/account.
- Falha antes do vault não produz status `CONNECTED`.
- Retry interno seguro pode retomar finalização quando aplicável.

---

## Epic D — Tokens LWA e credential lifecycle

### [x] AMZ-030 — Trocar authorization code por tokens LWA

**Prioridade/Tamanho:** P0 / M  
**Dependências:** AMZ-013, AMZ-023

**Entrega:** code exchange server-to-server no runtime Chameleon.

**Critérios de aceite:**

- Usa client credentials do vault e redirect registrado.
- Normaliza refresh/access token, expiração e metadata interna necessária.
- Resposta incompleta/malformada gera erro tipado.
- Tokens não aparecem em evento, redirect, SDK return, log ou snapshot.

### [x] AMZ-031 — Criptografar e persistir seller credentials

**Prioridade/Tamanho:** P0 / M  
**Dependências:** AMZ-030, credential vault pronto

**Entrega:** credential envelope ligado a environment/connection/provider.

**Critérios de aceite:**

- Refresh token chega criptografado ao banco.
- Associated data impede trocar ciphertext entre tenants/connections.
- Envelope possui key version e timestamps.
- Escrita participa da estratégia transacional de finalização.

### [x] AMZ-032 — Implementar geração/refresh de access token LWA

**Prioridade/Tamanho:** P0 / M  
**Dependências:** AMZ-031, refresh worker pronto

**Entrega:** refresh preventivo e on-demand dentro da plataforma.

**Critérios de aceite:**

- Usa clock injetado e margem antes da expiração.
- Distributed lock evita refresh storm.
- Novo refresh token é persistido atomicamente quando houver rotação.
- Invalid grant definitivo marca `REAUTHORIZATION_REQUIRED`.

### [ ] AMZ-033 — Implementar cache seguro de access token

**Prioridade/Tamanho:** P1 / M  
**Dependências:** AMZ-032

**Entrega:** cache interno curto e opcional.

**Critérios de aceite:**

- TTL é menor que validade oficial.
- Cache miss/degradação não quebra correctness.
- Keys de cache não expõem seller/token.
- Tokens quase expirados não são entregues ao executor.

---

## Epic E — Seller identity e connection

### [x] AMZ-040 — Definir fonte canônica da seller identity

**Prioridade/Tamanho:** P0 / S  
**Dependências:** AMZ-001, AMZ-030

**Entrega:** ADR apontando dados oficiais usados para seller ID e marketplaces autorizados.

**Critérios de aceite:**

- Não usa display name como identidade estável.
- Documenta se dados vêm do callback, token context ou endpoint oficial.
- Define comportamento para autorização sem marketplace US.

### [x] AMZ-041 — Recuperar seller/account identity

**Prioridade/Tamanho:** P0 / M  
**Dependências:** AMZ-032, AMZ-040

**Entrega:** implementação de `getAccount()` no provider.

**Critérios de aceite:**

- Recupera identificador estável e marketplaces autorizados.
- Usa somente permissões mínimas documentadas.
- Payload bruto não cruza o provider boundary.

### [x] AMZ-042 — Normalizar `MarketplaceAccount`

**Prioridade/Tamanho:** P0 / M  
**Dependências:** AMZ-041

**Entrega:** account pública com provider account ID, display name/country quando disponíveis e marketplace IDs.

**Critérios de aceite:**

- Metadata Amazon permanece interna/tipada.
- Mesma organization pode ter múltiplos sellers Amazon.
- Reconectar o mesmo seller não duplica account.
- Nenhum token ou role sensível aparece no objeto público.

### [ ] AMZ-043 — Finalizar connection e publicar evento

**Prioridade/Tamanho:** P0 / M  
**Dependências:** AMZ-024, AMZ-031, AMZ-042

**Entrega:** transição para `CONNECTED` e evento `connection.connected` via outbox.

**Critérios de aceite:**

- Evento só é visível após commit.
- SDK get/list enxerga account normalizada.
- Hosted Connect retorna sucesso sem provider credential.

---

## Epic F — Reconnect, disconnect, erros e throttling

### [x] AMZ-050 — Normalizar erros LWA/SP-API

**Prioridade/Tamanho:** P0 / L  
**Dependências:** AMZ-013

**Entrega:** mapper de config, consent, invalid grant, auth, roles, throttling e indisponibilidade.

**Critérios de aceite:**

- Erro público contém code, provider, retryable e Chameleon request ID.
- Falta de role é distinguida de credencial expirada/revogada.
- Cause sensível fica restrita, redigida e auditável.

### [ ] AMZ-051 — Implementar throttling e retry hints

**Prioridade/Tamanho:** P0 / M  
**Dependências:** AMZ-050, retry runtime pronto

**Entrega:** interpretação dos sinais oficiais nas operações usadas pelo provider.

**Critérios de aceite:**

- Respeita retry delay oficial quando presente.
- Usa backoff com jitter e orçamento máximo.
- Não repete code exchange ou operação não idempotente sem garantia.

### [x] AMZ-052 — Implementar reconnect Amazon

**Prioridade/Tamanho:** P0 / M  
**Dependências:** AMZ-020 a AMZ-043

**Entrega:** nova Connect Session/transaction para conexão que exige reautorização.

**Critérios de aceite:**

- Nunca reutiliza state/code anterior.
- Mantém o connection ID Chameleon quando a política permitir.
- Mesmo seller atualiza credentials/account atomicamente.

### [ ] AMZ-053 — Implementar disconnect/revocation Amazon

**Prioridade/Tamanho:** P0 / M  
**Dependências:** AMZ-043

**Entrega:** disconnect idempotente e revogação oficial quando suportada.

**Critérios de aceite:**

- Impede refresh/execução imediatamente após transição.
- Credenciais locais seguem a política de destruição/retenção.
- Falha remota tem comportamento explícito e gera evento seguro.

---

## Epic G — Restricted Data Token isolado

### [ ] AMZ-060 — Definir capability interna de RDT

**Prioridade/Tamanho:** P2 / M  
**Dependências:** AMZ-004, AMZ-032

**Entrega:** contrato futuro para solicitar token por recurso protegido.

**Critérios de aceite:**

- RDT não entra em `ProviderCredentials` genérico nem `MarketplaceAccount`.
- Recurso/escopo é obrigatório e least-privilege.
- Token não é persistido por padrão e tem TTL estrito.
- Amazon Connect funciona sem esta capability.

### [ ] AMZ-061 — Implementar RDT client mockável

**Prioridade/Tamanho:** P2 / M  
**Dependências:** AMZ-060

**Entrega:** client interno sem exportar token bruto nos SDKs públicos.

---

## Epic H — Backend SDK, Hosted Connect e webhooks

### [x] AMZ-070 — Expor Amazon nos tipos do Backend SDK

**Prioridade/Tamanho:** P0 / S  
**Dependências:** AMZ-020

**Entrega:** `provider: "amazon"` em create/filter/result e documentação correspondente.

**Critérios de aceite:**

- SDK envia chamadas somente à Chameleon Backend API.
- Não adiciona LWA config, SP-API secret ou callback handler ao cliente.

### [ ] AMZ-071 — Expor Amazon no Connect JS/React

**Prioridade/Tamanho:** P1 / S  
**Dependências:** AMZ-022, frontend SDK pronto

**Entrega:** label/logo/status e eventos genéricos.

**Critérios de aceite:**

- UI não contém fluxo Amazon específico além de presentation metadata.
- Retorno contém connection ID/status, nunca code/token.

### [ ] AMZ-072 — Entregar eventos Amazon pelo webhook genérico

**Prioridade/Tamanho:** P1 / M  
**Dependências:** AMZ-043, AMZ-052, AMZ-053, webhook system pronto

**Entrega:** connected, reauthorization required, disconnected e failed.

**Critérios de aceite:**

- Payload usa schema genérico de connection.
- Delivery é assinado, at-least-once e deduplicável por event ID.
- Nenhuma provider credential entra no payload.

---

## Epic I — Testes, documentação e validação

### [x] AMZ-080 — Criar testes unitários do provider

**Prioridade/Tamanho:** P0 / L  
**Dependências:** AMZ-020 a AMZ-053

**Entrega:** testes de authorization URL, callback, exchange, refresh, identity, erros e disconnect.

**Critérios de aceite:**

- Usa HTTP fake e fake clock; não acessa rede.
- Cobre sucesso, negação, state inválido, payload malformado, invalid grant e throttling.
- Verifica redaction em erros/logs/snapshots.

### [ ] AMZ-081 — Executar provider contract tests

**Prioridade/Tamanho:** P0 / M  
**Dependências:** AMZ-080

**Entrega:** Amazon passa na mesma suíte de Etsy/eBay conforme capabilities.

**Critérios de aceite:**

- Orchestrator, Backend API e SDKs não têm branches Amazon.
- Unsupported capabilities são declaradas, não simuladas.

### [x] AMZ-082 — Criar integração hosted ponta a ponta mockada

**Prioridade/Tamanho:** P0 / L  
**Dependências:** AMZ-070, AMZ-071, AMZ-080, AMZ-081

**Entrega:** Customer Backend SDK → Connect Session → Hosted Connect → callback → vault → account → webhook.

**Critérios de aceite:**

- Valida isolamento entre dois environments e duas organizations.
- Confirma ciphertext no banco e ausência de token em superfícies públicas.
- Exercita callback duplicado, refresh concorrente e falha parcial.

### [x] AMZ-083 — Documentar Amazon Connect para clientes

**Prioridade/Tamanho:** P1 / M  
**Dependências:** AMZ-070 a AMZ-082

**Entrega:** quickstart usando apenas Chameleon keys, SDK e Hosted Connect.

**Critérios de aceite:**

- Cliente não precisa entender LWA, SP-API refresh ou provider secrets.
- Explica estados, reconnect, webhooks e erros públicos.
- Diferencia test/live e requisitos do seller.

### [ ] AMZ-084 — Criar runbook operacional Amazon

**Prioridade/Tamanho:** P1 / M  
**Dependências:** AMZ-050, AMZ-051, observabilidade pronta

**Entrega:** diagnóstico de provider outage, invalid credentials, approval/role failure, throttling e refresh storm.

### [-] AMZ-090 — Validar com seller Amazon US real

**Prioridade/Tamanho:** P0 / M  
**Dependências:** AMZ-082, aplicação SP-API aprovada  
**Bloqueio esperado:** aprovação Amazon, roles adequadas e seller US de teste

**Critérios de aceite:**

- Seller conclui autorização pelo Hosted Connect.
- Callback Chameleon troca code e guarda refresh token no vault.
- Backend SDK consulta connection/account normalizadas.
- Refresh, reconnect, disconnect e webhook são validados.
- Evidências são sanitizadas e não contêm token, code, secret ou PII desnecessária.

---

## Ordem recomendada

```text
AMZ-001…AMZ-005
      ↓
AMZ-010…AMZ-013
      ↓
AMZ-020…AMZ-024
      ↓
AMZ-030…AMZ-033
      ↓
AMZ-040…AMZ-043
      ↓
AMZ-050…AMZ-053
      ↓
AMZ-070…AMZ-072
      ↓
AMZ-080…AMZ-084
      ↓
AMZ-090
```

`AMZ-060` e `AMZ-061` só entram quando uma operação futura realmente exigir dados restritos.

## Definition of Done Amazon

Amazon Connect está pronto quando:

- o cliente usa somente Chameleon Publishable/Secret Keys;
- toda autorização ocorre pelo Hosted Connect e callback Chameleon;
- application secrets e seller tokens ficam no credential vault;
- seller identity e marketplace IDs US são normalizados;
- Backend SDK, frontend SDK e webhooks expõem apenas recursos Chameleon;
- refresh, reconnect, disconnect, throttling e falhas têm comportamento seguro;
- unit, contract, integration e security tests passam;
- a abstração core não contém lógica específica da Amazon;
- validação real está concluída ou é o único item bloqueado por aprovação externa.
