# space-launch-mcp

MCP server para lançamentos espaciais — responde **quando será lançado algo para o espaço**, com filtros por **data, país, centro de lançamento (location/pad) e provedora**.

## Fontes de dados

| Fonte | Papel | Auth |
|---|---|---|
| [Launch Library 2](https://ll.thespacedevs.com/2.2.0) (`ll.thespacedevs.com`) | Principal: manifesto global (SpaceX, Rocket Lab, Arianespace, ISRO, CNSA…) + locations, pads, agências | Não (anônima com throttle; [chave via Patreon](https://thespacedevs.com/llapi) eleva o limite) |
| [SpaceX API v5](https://api.spacexdata.com/v5) | Secundária: detalhe SpaceX (busca/ordena/pagina no servidor via `POST /launches/query`). Se estiver fora do ar, as tools orientam o fallback para `list_upcoming_launches` com `provider_name='SpaceX'` | Não |
| [RocketLaunch.Live](https://www.rocketlaunch.live/api) (`fdo.rocketlaunch.live`) | Fallback independente: próximos lançamentos com janela/t0 e clima do pad. Tier gratuito = próximos 5, sem key | Não (grátis até 5); `RLL_API_KEY` opcional (Premium = catálogo completo) |
| [Spaceflight News API v4](https://api.spaceflightnewsapi.net/v4/docs/) | Contexto: articles/blogs/reports sobre o setor (não é manifesto — sem NET/pad) | Não |

Outras APIs avaliadas e **não** integradas: `api.nasa.gov` (sem endpoint de manifesto — DONKI é clima espacial; exige key), ESA/JAXA (sem API REST pública de lançamentos), Next Spaceflight (sem API pública), FlightClub.io (exige key; telemetria/trajetória, não agenda), Gunter's Space Page (site estático, sem API), Space-Track.org (exige login; TLEs, não agenda), N2YO (exige key; tracking).

## Ferramentas (9)

- `list_upcoming_launches` — lista lançamentos (`mode`: `upcoming` | `previous`). Filtros: `search`, `window_start_gte` / `window_start_lte` (ISO, ex. `2026-10-01`), `country_code` (alpha-3, ex. `USA`, `JPN`, `FRA`), `location_id`, `pad_id`, `provider_id` ou `provider_name` (ex. `SpaceX`), `limit`/`offset`.
- `get_launch` — detalhe de um lançamento por id/slug LL2.
- `list_launch_locations` — centros/espaçoportos (`search`, `country_code`, `limit`/`offset`).
- `list_launch_pads` — plataformas (`search`, `location_id`, `limit`/`offset`).
- `list_launch_providers` — provedoras/agências (`search`, `limit`/`offset`).
- `list_spacex_launches` / `get_spacex_launch` — fonte secundária SpaceX (`limit`/`offset`).
- `list_rocketlaunch_live` — fallback RLL (`limit`, máx. 5 no tier gratuito).
- `list_spaceflight_news` — notícias (`type`: `article` | `blog` | `report`, `search`, `limit`/`offset`).

Erros de tool voltam como resultado estruturado (`isError: true`, texto `Error: …`) sem derrubar a sessão.

## Desenvolvimento

```bash
npm install
npm run build
npm test          # build + vitest (suite offline + protocolo MCP local)
LIVE=1 npx vitest run tests/live.test.ts  # smoke contra as APIs reais (opt-in)
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
    args: [/home/hermes/github/space-launch-mcp/dist/index.js]
    enabled: true
```

Depois reinicie o gateway Hermes.

## Configuração

- `SPACE_LAUNCH_TIMEOUT_MS` — timeout por requisição HTTP em ms (padrão `12000`, máx. `60000`).
  Avisos (timeout, retries 429/5xx, `country_code` ignorado quando `location_id` é dado)
  vão para stderr com prefixo `[space-launch-mcp]`.
- `RLL_API_KEY` — opcional; chave Premium da RocketLaunch.Live (sem ela, `list_rocketlaunch_live` usa o tier gratuito: próximos 5).

## Licença

MIT
