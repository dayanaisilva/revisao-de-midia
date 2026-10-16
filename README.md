# Agente de Mídia

Portal e serviço central do Agente de Mídia da Loggia.

## Arquitetura

- O site continua no GitHub Pages.
- O serviço `agente-de-midia` roda no Render e decide o destino de cada solicitação.
- Pedidos de auditoria são encaminhados aos workflows já existentes no n8n.
- Perguntas comuns ficam fora do n8n. A conexão com conhecimento, campanhas e Slack entra nas próximas etapas.

## Rotas do serviço

- `GET /health`: saúde da central.
- `GET /api/capabilities`: integrações já habilitadas.
- `POST /api/route`: classifica uma solicitação como `AUDIT`, `AUDIT_STATUS` ou `KNOWLEDGE`.
- `POST /api/audits`: encaminha um plano XLSX ao webhook de auditoria.
- `POST /api/audits/status`: consulta o andamento ou o resultado no n8n.

O proxy não grava o XLSX e não registra o conteúdo do plano em logs.

## Variáveis do Render

- `N8N_AUDIT_URL`: webhook de recepção do plano.
- `N8N_STATUS_URL`: webhook de consulta da auditoria.
- `ALLOWED_ORIGINS`: origens permitidas, separadas por vírgula.

Os endereços dos webhooks devem ser configurados como variáveis protegidas no Render.

## Desenvolvimento

```sh
npm test
npm start
```

Depois que o serviço estiver publicado e validado, `config.js` pode ser alterado para apontar o site para as rotas do Render. Até lá, o portal continua usando diretamente os webhooks atuais do n8n.
