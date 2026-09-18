# space-launch-mcp

MCP server para lançamentos espaciais — responde **quando será lançado algo para o espaço**, com filtros por **data, país, centro de lançamento (location/pad) e provedora**.

## Fontes de dados

| Fonte | Papel | Auth |
|---|---|---|
| [Launch Library 2](https://ll.thespacedevs.com/2.2.0) (`ll.thespacedevs.com`) | Principal: manifesto global (SpaceX, Rocket Lab, Arianespace, ISRO, CNSA…) + locations, pads, agências | Não |
| [SpaceX API v5](https://api.spacexdata.com/v5) | Secundária: detalhe SpaceX. Se estiver fora do ar, as tools orientam o fallback para `list_upcoming_launches` com `provider_name='SpaceX'` | Não |

## Ferramentas (7)

- `list_upcoming_launches` — lista lançamentos (`mode`: `upcoming` | `previous`). Filtros: `search`, `window_start_gte` / `window_start_lte` (ISO, ex. `2026-10-01`), `country_code` (alpha-3, ex. `USA`, `JPN`, `FRA`), `location_id`, `pad_id`, `provider_id` ou `provider_name` (ex. `SpaceX`), `limit`/`offset`.
- `get_launch` — detalhe de um lançamento por id/slug LL2.
- `list_launch_locations` — centros/espaçoportos (`search`, `country_code`).
- `list_launch_pads` — plataformas (`search`, `location_id`).
- `list_launch_providers` — provedoras/agências (`search`).
- `list_spacex_launches` / `get_spacex_launch` — fonte secundária SpaceX.

## Desenvolvimento

```bash
npm install
npm run build
npm test          # build + vitest (suite offline + protocolo MCP local)
npm run dev       # roda via tsx (stdio)
```

Exemplos de perguntas que o MCP responde:

- "Quais lançamentos há em outubro de 2026?" → `list_upcoming_launches` com `window_start_gte: '2026-10-01'`, `window_start_lte: '2026-10-31'`
- "Próximos lançamentos do Japão?" → `country_code: 'JPN'`
- "Lançamentos de Kourou / Cabo Canaveral?" → `list_launch_locations` com `search`, depois `location_id`
- "Próximos da SpaceX?" → `provider_name: 'SpaceX'`

## Instalação no Hermes

```yaml
# ~/.hermes/config.yaml
mcp_servers:
  space-launch:
    command: node
    args: [/home/hermes/space-launch-mcp/dist/index.js]
    enabled: true
```

Depois reinicie o gateway Hermes.

## Licença

MIT
