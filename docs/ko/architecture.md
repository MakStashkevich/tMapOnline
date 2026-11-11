# tMapOnline 아키텍처

이 문서는 tMapOnline의 구성과 게임 데이터가 브라우저 지도에 도달하는 과정을 설명합니다. Python 서비스가 데이터를 받아 저장하고 API를 통해 웹 지도에 제공합니다. 서버 모드는 tModLoader 안에서 게임 데이터를 수집합니다.

데이터 흐름은 Terraria → 모드 → 서비스 → 브라우저 순서입니다. 서비스가 응답을 준비하고 브라우저가 지도와 마커로 표시합니다. 브라우저와 Python 서비스는 Terraria 프로세스 메모리를 직접 읽지 않습니다.

간단히 말하면 모드는 게임을 읽고, Python 서비스는 데이터를 받고, 브라우저는 표시합니다. API는 브라우저와 서비스가 데이터를 주고받는 주소입니다. snapshot은 특정 시점의 게임 상태 기록이고, cache는 준비된 데이터를 저장해 다시 생성하지 않도록 합니다.

## 프로젝트와 책임 경계

```text
tMapOnline/                       # 웹 지도, backend, 모드
├── tmaponline/                  # Python 패키지와 tModLoader 모드
│   ├── backend/                 # 요청, 응답, 웹 파일 제공
│   ├── telemetry/               # 게임 모드 연결
│   ├── sprite_renderer/         # 게임 텍스처와 PNG 스프라이트
│   ├── web/
│   │   ├── src/                 # 편집 가능한 UI와 지도 소스
│   │   ├── assets/              # 빌드 결과물
│   │   ├── static/              # 원본 이미지, 폰트 등 리소스
│   │   └── world-map/           # 웹 지도 진입 페이지
│   ├── tmodloader/
│   │   └── tMapOnline/          # 서버 모드 C# 소스
│   ├── config.py                # YAML 읽기, 검증, 기본값
│   └── runtime.py               # 서비스 및 게임 프로세스 수명주기
├── docs/                        # 프로젝트 문서
├── tests/                       # Python 및 웹 자동 검사
├── tools/                       # 웹과 모드 빌드 명령
├── config.example.yaml
├── package.json
└── pyproject.toml
```

`backend/http.py`는 브라우저 요청을 처리하고 응답을 선택합니다. `backend/store.py`는 실제 파일 구조를 몰라도 다른 코드가 데이터를 다룰 수 있는 공통 인터페이스입니다. `backend/services/`는 역할별로 나뉩니다. `player_history`는 플레이어 이력, `movement`는 이동, `live_telemetry`는 최신 게임 데이터, `monitoring`은 서버 상태, `world_map`은 지도를 담당합니다.

공통 형식과 상수는 `store_common.py`에 있습니다. 저장소는 큰 클래스 하나가 아니라 작은 책임 단위로 나뉩니다. 잠금은 여러 작업이 같은 데이터를 동시에 바꾸지 않게 하고, 캐시는 최근 결과를 재사용합니다.

JSONL에서는 메시지 하나가 한 줄입니다. 서비스는 각 줄을 검증하고 알려진 필드가 있는 `models/telemetry.py` 모델로 변환합니다. 덕분에 데이터를 다루고 오류를 찾기 쉽습니다. 프로그램 경계에서는 브라우저와 다른 클라이언트가 기대하는 형식으로 변환합니다.

업데이트 간격은 `config.yaml`에서 설정합니다. 움직이는 마커와 큰 지도를 같은 빈도로 보낼 필요는 없습니다. tModLoader는 위치, 엔티티, 지도 색 데이터를 따로 보내며, 모드는 메시지 사이에 각 범주의 최신 값을 보관합니다.

첫 `/api/world-map` 요청은 월드 크기와 사용 가능한 레이어 설명 등 메타데이터만 반환하고 픽셀 chunk는 포함하지 않습니다. chunk는 완성 이미지의 사각 영역입니다. 내보내기처럼 전체 데이터가 필요할 때는 `?tiles=0`을 명시해 모든 chunk를 포함한 JSON을 요청할 수 있습니다.

브라우저는 보이는 영역의 객체만 그립니다. 표시되는 플레이어나 객체마다 스프라이트가 있는 HTML 요소를 만들고, 지도를 이동하거나 확대할 때 화면에 둘 마커를 다시 계산합니다. 이는 표시만 바꾸며 게임의 NPC를 생성하거나 제거하지 않습니다.

지도 이미지는 피라미드 레벨로 나뉩니다. 멀리 볼 때는 작은 개요 타일을, 확대하면 더 자세한 타일을 사용합니다. 서버는 최대 256 × 256 픽셀 PNG 타일을 제공하고 요청 영역과 교차하는 chunk만 준비합니다. 준비된 PNG는 cache에 보관해 다시 만들지 않습니다. cache는 항목 수와 총 32 MiB로 제한되며 `/debug`에서 적중, 제거, 이미지 준비 시간을 볼 수 있습니다.

canvas는 브라우저의 이미지 그리기 표면입니다. 지도 타일은 최대 16개, 디코딩된 이미지는 4 MiB까지만 활성화합니다. 지도와 탐험 마스크는 별도 canvas를 사용하므로 마스크 갱신이 기본 이미지를 다시 받게 하지 않습니다. 세부 수준이 바뀌어도 새 이미지가 도착할 때까지 이전 이미지를 보여 빈 배경이 번쩍이지 않게 합니다. 화면 밖 타일은 DOM에 추가하지 않습니다. 전체 데이터는 명시적으로 내보낼 때만 읽습니다.

현재 위치, 사망, 코인, 블록 변경은 `/api/world-map/live`로 전달됩니다. SSE(Server-Sent Events)는 HTTP 연결을 열어 둔 채 새 메시지를 서버에서 받을 수 있게 합니다. 객체마다 별도 요청을 보낼 필요가 없습니다. 서버는 보이는 영역과 약간의 여유분 데이터를 보내고, 지도가 크게 이동하면 브라우저가 구독을 갱신합니다. 코인 레이어는 크게 확대했을 때만 요청합니다.

블록이 바뀌면 서버가 데이터를 저장하고 브라우저는 해당 블록이 포함된 이미지 타일만 갱신합니다. 다음 갱신 전에 같은 좌표가 여러 번 바뀌면 마지막 상태를 사용합니다. 다른 타일은 사용자가 해당 위치로 이동했을 때 갱신됩니다. `/debug`에서 snapshot 빈도와 최신성, 응답 크기, 이미지 준비 시간을 확인할 수 있습니다.

`telemetry/stream.py`는 줄바꿈으로 구분된 JSON snapshot을 받습니다. 모드는 서버 상태를 수집해 localhost로 보냅니다. 웹은 게임 프로세스에 직접 연결하지 않고 공통 API를 읽습니다.

### 스프라이트 렌더링

`sprite_renderer/xnb_texture.py`는 XNB 헤더를 확인하고 `Texture2D`의 RGBA 데이터를 읽습니다. `sprite_renderer/lzx.py`가 32 KiB 프레임을 포함한 압축 XNB를 풀기 때문에 외부 LZX 패키지나 Java runtime은 필요 없습니다. `PlayerSpriteRenderer`, `NpcSpriteRenderer`, `MapItemSpriteRenderer`는 플레이어 아바타, NPC/보스 초상화, 아이템 아이콘을 합성합니다. Pillow는 PNG 읽기/쓰기 경계에서만 사용하고, cache와 이미지 URL은 `StatusStore`가 관리합니다. tModLoader 모드는 C#입니다.

게임 마커와 일치시키기 위해 같은 Terraria/tModLoader 버전의 디컴파일 코드와 비교합니다. 사망 십자 표시는 게임 리소스 `Content/Images/MapDeath.xnb`에서 가져오며 `Main.DrawPlayerDeathMarker`가 `Player.lastDeathPostion` 좌표에 지도 배율로 중앙 배치합니다. 따라서 tMapOnline은 인위적인 그림자나 외곽선 없이 원본 스프라이트를 사용합니다. 디컴파일 코드는 개발 참고 자료이며 저장소에 포함되지 않고 실행에도 필요하지 않습니다.

### tModLoader 구성과 서비스

텔레메트리 스트림은 설정 가능한 게임 tick 간격으로 snapshot을 보냅니다. 사망은 `Player.KillMe`에서 잡아 고유 ID를 부여하고, Python 서비스가 저장을 확인할 때까지 모드 대기열에 둡니다. Python은 저장된 마커에 설정된 TTL을 적용합니다. 플레이어와 NPC 방향은 좌표와 별도로 전송되어 UI가 게임처럼 스프라이트를 좌우 반전할 수 있습니다.

`TMapOnlineSystem`은 수명주기와 composition root입니다. 게임 hook을 연결하고 서비스를 만들며 기존 JSONL/API 계약을 유지하면서 JSON snapshot을 구성합니다. 세부 동작은 책임이 좁은 객체에 맡깁니다. composition root는 객체를 만들고 연결합니다. service는 한 가지 작업을 담당합니다. hook은 월드 변경 같은 이벤트에 따라 게임이 모드 코드를 호출하는 지점입니다.

- `TelemetryStreamServer`: TCP listener, 클라이언트, JSONL, snapshot 확인, 수신 명령.
- `WorldMapScanner`: 게임 tick마다 작은 기본 지도 chunk를 스캔하고 팔레트를 준비해 진행 상황을 보고.
- `PlayerMapChangeRevealer`: 플레이어 주변 탐험 영역을 만들고 반복 캡처를 제한.
- `MapTileDataCapture`: 블록/벽 ID를 직렬화하고 영역을 압축.
- `MapTileNameCatalog`: 블록/벽의 현지화 이름을 조회해 데이터와 함께 순차 전송.
- `PlayerAppearanceSnapshotBuilder`: 플레이어 외형을 수집하고 필요한 텍스처를 내보냄.
- `WorldEntitySnapshotBuilder`: 파일런, NPC/보스, 드롭 코인 마커를 수집.
- `BossProgressSnapshotReader`: 바닐라 진행 플래그만 읽음.
- `CalamityBossProgressAdapter`: 선택적 Calamity 모드와 저장된 플래그를 별도로 조회.
- `BossVictoryTracker`: 반복 승리를 `ApplicationData/tMapOnline/boss-victories.json`에 저장.

서비스에는 필요한 상태만 전달합니다. `Main`, `Player`, `NPC`, 타일, 팔레트, 지도 읽기/변경은 게임 스레드에서 동기적으로 수행합니다. 백그라운드 전송은 직렬화된 불변 JSONL 문자열을 받고 살아 있는 게임 객체는 받지 않습니다. 지도 초기화를 위해 `Main.dedServ`를 대체하지 않습니다.

## 웹 인터페이스 구조

`web/world-map/index.html`은 tMapOnline 웹 지도 유일한 진입점입니다. `/`와 `/world-map`은 같은 지도를 열고 이전 모니터링 화면은 비활성화되어 있습니다. UI, 지도, 섹션, 스타일 원본은 `web/src`에 있습니다. `npm run build`는 TypeScript를 압축된 ES modules로, SCSS를 CSS로 컴파일해 `web/assets`에 저장합니다. 운영 환경에서는 Python이 파일을 제공하므로 Node.js가 필요 없습니다.

`src/app-shell.ts`의 `TMapOnlineApplication`은 섹션 데이터를 필요할 때 불러와 픽셀 대화창에 엽니다. 지도는 즉시 전체 화면을 차지합니다. `MapActionMenu`는 세로 카테고리와 옆의 하위 메뉴를 만들고, `PixelModal`은 닫기, Escape, 키보드 포커스를 처리합니다. 플레이어와 경로는 플레이어 창에서 설정하고 즉시 지도에 반영됩니다. `MapZoomControls`는 픽셀 확대 버튼과 전체 월드 보기를 지도 컨트롤러에 연결합니다. `src/sections/{world,players,bosses,server,activity}.ts` 및 스타일은 메뉴를 열 때 동적으로 불러옵니다.

카테고리에는 플레이어/경로, 월드 데이터/보스 승리, 서버, 활동이 있습니다. 진단은 `/debug`에서도 볼 수 있습니다. `site.sections`에서 섹션을 활성화합니다. Backend는 간결한 `/api/section-data?section=...`으로 제공합니다. 보스 진행 데이터에는 활성 보스, 바닐라 승리 플래그, 호환되는 반복 승리 횟수, 선택적 Calamity 상태가 들어갑니다. 전체 `/api/status`는 호환성을 위해 유지되지만 모달의 데이터 소스로 사용하지 않습니다. 모달을 열어도 지도 업데이트는 계속됩니다.

UI는 frontend runtime이나 컴포넌트 라이브러리 없이 표준 ES modules를 사용합니다. shell은 메뉴/대화창, 각 섹션 SCSS는 픽셀 스타일, `mount(root)`는 요청과 렌더링을 담당합니다. 개발 또는 패키징 중 esbuild와 Sass를 실행합니다. 분석, 플레이어 이력, 로그는 사용자가 해당 창을 열기 전까지 불러오지 않습니다.

### TypeScript 객체와 책임

`src/map/world-map.ts`는 지도 페이지 composition root로 남습니다. 설정 가능한 기능을 켜고 데이터 생명주기와 표시를 연결해 지도 레이어를 갱신합니다. 개별 객체는 각 메커니즘을 담당합니다.

- `MapSnapshotCache`: IndexedDB와 저장 상태 복구.
- `MapChunkCodec`: 기본 chunk와 업데이트의 디코딩/조합.
- `MapPyramidLayerRenderer`: 세부 수준 선택, 보이는 PNG 타일 로딩, viewport가 바뀌면 오래된 HTTP 요청 취소, 확대 지점 근처 타일 우선 로딩. 활성 지점이 없으면 viewport 중앙을 먼저 로드.
- `MapExplorationMask`: 가져온 지도와 경로를 탐험 마스크로 결합.
- `MapImageExporter`: 탐험 마스크가 켜진 경우 적용해 지도 PNG 내보내기.
- `MapViewportController`: 확대, 이동, 제스처, viewport 이벤트. 확대 지점의 월드 좌표를 renderer에 전달해 해당 타일을 먼저 요청.
- `MapZoomControls`: 확대 버튼과 전체 월드 보기 복귀.
- `MapEntityLayer`: 플레이어, NPC/보스, 코인, 파일런, 스폰 지점 마커. 화면 밖 좌표는 DOM 스프라이트나 애니메이션 루프를 만들지 않음.
- `MapTooltipController`: hover 지연, 블록 정보 cache, 툴팁.
- `MapPlayerPathService`: 플레이어 기록 정규화, 경로 cache, 텔레포트 전후 탐험 구간 분리.
- `MapRouteLayer`: SVG 경로와 현재 위치 마커.
- `MapDiagnosticsPanel`: 스캐너 상태와 진단 패널.

새 지도 기능은 역할이 명확하고 의존성이 분명한 객체에 넣습니다. chunk codec, IndexedDB 수명주기, 제스처 처리, 마커 DOM을 `world-map.ts`에 다시 넣지 않습니다. 관련 기능을 수정할 때 큰 흐름을 나누고, 상태나 동작이 없는 얇은 wrapper class는 만들지 않습니다.

Frontend 명령: `npm ci`는 lock 파일에 고정된 도구를 설치하고, `npm run typecheck`는 TypeScript를 검사하며, `npm run build`는 `web/assets`를 갱신하고, `npm run check:web`는 두 작업을 순서대로 실행합니다. 소스를 바꾼 뒤 실행/패키징 전에 assets를 다시 빌드합니다. Python은 Pyright strict로 검사합니다(Pylance도 같은 엔진 사용): `npm run check:python`. 로컬 환경은 `python3 -m pip install -r requirements-dev.txt` 후 `npm ci`를 실행합니다. 전체 검사는 `npm run check:all`입니다. 유연한 JSON 저장소를 쓰는 기존 4개 service는 알 수 없는 타입 진단만 끄지만, 사용하는 필드는 런타임에 확인하며 나머지 strict 규칙은 유지합니다.

## 상태와 설정

`config.yaml`은 실행과 페이지/섹션 활성화를 제어합니다. 브라우저 테마, 선택한 플레이어/레이어, 지도 위치는 `localStorage`에 따로 저장됩니다. 개인 데이터와 캐시는 저장소가 아니라 `~/Library/Application Support/tMapOnline`에 있습니다. API와 텔레메트리 schema는 [telemetry.md](telemetry.md)를 참고하세요.

서비스 실행 설정과 페이지/컴포넌트 활성화는 분리되어 있습니다. 사용자 표시 설정도 서버 설정과 별도로 보관합니다.
