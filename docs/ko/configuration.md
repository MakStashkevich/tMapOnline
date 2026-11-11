# 설정과 웹 섹션

이 문서는 서버 설정을 설명합니다. YAML은 들여쓰기를 사용하는 텍스트 형식이며 공백으로 설정이 속한 그룹을 나타냅니다. 서버 설정은 수집할 데이터와 사용할 기능을 정하고 모든 방문자에게 공통 적용됩니다. 확대율과 레이어 표시 여부는 브라우저별로 `localStorage`에 저장됩니다.

`tmaponline/config.py`가 시작 전에 파일을 읽고 설정을 검증합니다. 생략된 값은 기본값을 사용합니다. 수정 후 서비스를 재시작해야 새 값이 적용됩니다.

```yaml
site:
  world_map:
    route_history_days: 7 # 경로 기록 기간(일, 1–365)
  pages:
    world_map: { enabled: true }
  sections:
    world: true
    players: true
    bosses: true
    server: true
    activity: true
  modules:
    world_map.exploration: true
    world_map.entities: true
```

예시의 `site` 그룹은 웹 지도와 섹션을 설정합니다. 파일에는 `storage`, `telemetry` 그룹도 있습니다. 콜론 뒤 값은 `true`면 켜고 `false`면 끕니다. `7`은 최근 7일 경로를 요청한다는 뜻입니다. 들여쓰기 공백은 설정의 그룹을 결정하므로 유지하세요.

플레이어 카드에서 “경로 기록”을 켜면 지도는 `site.world_map.route_history_days` 기간의 저장된 좌표를 자동 요청합니다. 1~365일을 지정하세요.

다음은 기록 보존 및 업데이트 간격입니다. 텔레메트리는 게임 중 모드가 서비스에 자동으로 보내는 정보입니다.

```yaml
storage:
  death_retention_seconds: 3600 # 0 — 사망 기록 무기한 보관
  event_retention_seconds: 2592000 # 30일; 0 — 기간 제한 없음
  event_max_entries: 5000 # 최대 이벤트 수
telemetry:
  player_position_interval_ticks: 6 # 플레이어 위치, 6 tick ≈ 100ms
  entity_interval_ticks: 6 # NPC, 보스, 코인, 파일런
  map_capture_interval_ticks: 30 # 플레이어 주변 지도 색상 데이터
  map_tile_update_interval_ticks: 1 # 변경된 타일/벽, 폭발 포함
  map_pings_from_players_to_web: true # 게임 ping을 웹 지도에 표시
  map_pings_from_web_to_players: true # 웹 ping을 플레이어에게 전송
  initial_world_scan_enabled: true # tMapOnline 시작 시 전체 월드 스캔
  world_scan_interval_ticks: 1 # 스캐너 chunk 처리 간격
  browser_live_poll_interval_ms: 50 # 가벼운 실시간 데이터 요청 간격
  browser_overview_poll_interval_ms: 250 # 전체 지도 보기의 실시간 갱신 간격
  browser_map_poll_interval_ms: 5000 # 지도 업데이트 요청 간격
  browser_debug_poll_interval_ms: 1000 # debug 설정을 열었을 때의 지도 간격
```

보존 기간은 이미 저장한 사망 기록에도 적용됩니다. 모드는 사망 이벤트마다 고정 ID를 보내고 Python 서비스의 확인을 기다립니다. 연결이 끊기면 이벤트는 대기열에 남아 다시 전송됩니다.

이벤트 로그는 시작 시와 새 기록이 추가될 때 정리됩니다. 먼저 `storage.event_retention_seconds`보다 오래된 항목을 지우고, 최신 `storage.event_max_entries`개만 남깁니다. 기간을 `0`으로 해도 개수 제한은 적용됩니다.

일부 간격은 게임 tick 단위입니다. tick은 게임 한 단계이며 초당 60 tick이면 6 tick은 약 100ms입니다. tMapOnline은 이 값을 모드에 전달합니다. 브라우저 간격은 밀리초이며 1000ms가 1초입니다. 큰 지도는 별도로 불러오고 위치, 객체, 작은 블록 변경은 `/api/world-map/live`에서 받아 전체 지도를 반복 다운로드하지 않습니다.

사용 가능한 설정과 기본값은 `config.example.yaml`에 있습니다. 실제 파일은 `--config`로 전달합니다. 예: `tmaponline --config config.local.yaml serve`.

| 키                                            | 용도                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------------------- |
| `site.pages.world_map.enabled`                | tMapOnline 웹 지도를 켭니다.                                                            |
| `site.sections.*`                             | 월드, 플레이어, 보스, 서버, 활동 섹션을 켭니다. 섹션을 열 때 데이터를 요청합니다.       |
| `site.modules.world_map.*`                    | 탐험, 경로, 플레이어, 엔티티, 코인, 파일런, 스폰 지점, 툴팁, 진단 레이어를 켭니다.      |
| `storage.death_retention_seconds`             | 사망 마커 보존 시간(초). `0`은 자동 정리 없음. 기본 3600.                               |
| `storage.event_retention_seconds`             | 로그 이벤트 보존 시간(초). `0`은 기간 제한 없음. 기본 2592000(30일).                    |
| `storage.event_max_entries`                   | 최신 로그 항목 최대 수. 기본 5000.                                                      |
| `telemetry.player_position_interval_ticks`    | 게임 tick 단위 플레이어 위치 간격. 로컬 서버는 `1`.                                     |
| `telemetry.entity_interval_ticks`             | NPC, 보스, 코인, 파일런 간격. 로컬 서버는 `1`.                                          |
| `telemetry.map_capture_interval_ticks`        | 플레이어 주변 지도 색상 캡처 간격.                                                      |
| `telemetry.initial_world_scan_enabled`        | 최초 전체 월드 스캔을 켭니다. 이동과 타일 변경 업데이트를 시험할 때는 끕니다.           |
| `telemetry.world_scan_interval_ticks`         | 월드 스캐너 chunk 처리 간격.                                                            |
| `telemetry.map_tile_update_interval_ticks`    | 변경 타일/벽 전송 간격. hook이 채굴, 설치, 폭발을 추적합니다.                           |
| `telemetry.map_pings_from_players_to_web`     | 플레이어 ping을 웹 지도로 보냅니다.                                                     |
| `telemetry.map_pings_from_web_to_players`     | 웹 지도 ping을 서버 플레이어에게 보냅니다.                                              |
| `telemetry.browser_live_poll_interval_ms`     | 브라우저 경량 요청 간격. 부드러운 마커 이동을 위한 기본값은 50ms입니다.                 |
| `telemetry.browser_overview_poll_interval_ms` | 축소 지도에서 실시간 요청 간격. 마커는 프레임별이 아닌 단계별로 이동합니다. 기본 250ms. |
| `telemetry.browser_map_poll_interval_ms`      | 브라우저의 지도 chunk 요청 간격. 현재 5000ms.                                           |
| `telemetry.browser_debug_poll_interval_ms`    | debug 설정을 열었을 때 지도 갱신 간격. 현재 1000ms.                                     |

비활성 페이지는 `404`를 반환합니다. 비활성 섹션은 메뉴에서 사라지고 데이터를 불러오지 않습니다. 비활성 레이어는 그리지 않습니다. 새 레이어를 추가하려면 기본값을 정하고 `tmaponline/web/src/core/modules.ts`에 등록한 뒤 이 문서에도 설명을 추가하세요. 브라우저 사용자가 바꾸는 설정은 YAML에 기록되지 않습니다.

## UI 빌드

편집 가능한 웹 UI 파일은 `tmaponline/web/src`에 있습니다. 동작은 TypeScript, 외형은 `styles`의 SCSS로 작성합니다. 빌드 명령:

```sh
npm ci
npm run format
npm run check:web
```

빌드는 압축된 ES modules와 CSS를 `tmaponline/web/assets`에 만듭니다. 운영 환경에서 Python이 제공하므로 Node.js는 필요하지 않습니다. 지도, 플레이어, 보스, 서버, 활동 섹션은 각자 CSS가 있는 동적 chunk로 유지됩니다.

`npm ci`는 lock 파일의 고정 버전을 설치합니다. `npm run format`은 프로젝트 규칙에 맞게 정리하고 `npm run check:web`는 웹 코드를 검사하고 빌드합니다. `assets`는 생성물이므로 `src` 또는 `static`의 원본을 수정하세요.
