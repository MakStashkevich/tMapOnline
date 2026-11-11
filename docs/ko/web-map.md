# tMapOnline 웹 지도

이 문서는 웹 지도가 동작하는 방식을 설명합니다. 브라우저는 Terraria에 직접 연결하지 않고 Python 서비스에서 지도와 게임 데이터를 받습니다. tModLoader 모드는 게임 정보를 서비스로 보냅니다. 서비스는 API 응답, 이미지, 기록을 준비합니다.

타일과 chunk는 서로 다른 뜻입니다. 타일은 Terraria 세계의 게임 격자 하나이고, chunk는 브라우저가 따로 불러오는 완성된 이미지의 사각 영역입니다.

## API에서 화면의 픽셀까지

1. `web/src/map/world-map.ts`가 지도를 만들고 `/api/site-config`에서 기능을 읽은 다음, 월드 메타데이터를 요청하고 renderer와 controller를 연결합니다.
2. 서버는 `GET /api/world-map/tile?world=…&level=…&x=…&y=…`로 이미 만들어진 PNG 조각을 보냅니다. 브라우저는 RGB 배열을 전송받지 않으며 페이지를 열 때마다 지도 전체를 다시 색칠하지 않습니다.
3. `MapSnapshotCache`는 클라이언트 snapshot과 chunk를 IndexedDB에 저장합니다. `MapPyramidLayerRenderer`는 낮은 해상도의 전체 보기를 유지하고 현재 확대율에 맞는 상세 레벨을 선택합니다. 화면 안의 조각을 먼저 불러오고 오래된 요청은 취소합니다.
4. `MapViewportController`는 휠 확대, pinch 확대, 드래그를 viewport 좌표로 바꿉니다. 확대 기준점의 월드 좌표를 사용해 네트워크 요청의 우선순위를 정합니다.
5. 별도의 가벼운 live 요청은 플레이어와 엔티티를 갱신합니다. NPC, 파일런 등은 지도 이미지 위의 독립된 DOM 레이어에 표시됩니다.
6. 타일 변경은 telemetry delta로 도착해 backend 저장소를 갱신하고, 해당 위치의 기본 이미지 및 피라미드 PNG chunk를 다시 만듭니다.

renderer는 데이터를 그리는 부분이고 controller는 사용자 입력과 요청 순서를 처리합니다. delta는 지도 전체가 아니라 변경 사항만 담은 작은 메시지입니다.

지도 레이어는 서로 독립적으로 갱신됩니다. 기본 레이어는 월드 이미지, 탐험 레이어는 발견한 영역을 표시합니다. mask는 흑백 이미지로, 탐험 레이어를 어디에 보일지 결정합니다. 다른 레이어에는 현재 위치, 이동 경로, Map Ping, 배경, UI 컨트롤이 있습니다. 새 레이어는 API에서 데이터를 받아 그 레이어를 그리는 컴포넌트에 전달해야 합니다. 한 레이어의 변경 때문에 나머지 레이어를 다시 불러오면 안 됩니다.

## 상태의 소유자

| 상태                                             | 기준 데이터                        | 페이지 새로고침 후 유지                        |
| ------------------------------------------------ | ---------------------------------- | ---------------------------------------------- |
| 서버 기능, 수집 간격, 경로 기록 기간             | `config.yaml`과 `/api/site-config` | 예                                             |
| 레이어, 움직임 부드러움, 표시 주기               | 브라우저 `localStorage`            | 예, 현재 브라우저 프로필에서만                 |
| chunk와 클라이언트 캐시 상태                     | 브라우저 IndexedDB                 | 예, 브라우저가 사이트 데이터를 지울 때까지     |
| 탐험 지도, 플레이어/세션 기록, 이벤트, 보스 진행 | tMapOnline 데이터 디렉터리의 파일  | 예, 브라우저와 무관                            |
| 실시간 위치와 현재 NPC                           | 서버 모드의 최신 snapshot          | 아니요. 원본이 멈추거나 데이터가 오래되면 만료 |
| 지도 텍스처/마스크와 PNG 피라미드                | 월드 및 프로필별 backend 저장소    | 예                                             |

`localStorage`는 브라우저 설정을, IndexedDB는 chunk 같은 더 큰 클라이언트 데이터를 보관합니다. 이 데이터는 브라우저와 기기에 속하므로 다른 휴대폰과 자동 동기화되지 않습니다. 서버 데이터 디렉터리는 tMapOnline이 실행되는 컴퓨터의 일반 파일입니다.

웹 표시 설정은 서버 전체 설정이 아니라 각 브라우저 사용자의 설정이며 기기 간 동기화되지 않습니다. 서버 설정은 레이어를 완전히 비활성화할 수 있습니다. 브라우저의 스위치로 서버에서 꺼 둔 기능을 켤 수는 없습니다.

## 주요 컴포넌트

- `app-shell.ts`와 `core/modules.ts`: 메뉴, 설정 가능한 동작/섹션, 공통 확장 지점.
- `components/map-display-settings.ts`: 브라우저에 저장하는 지도 설정과 변경 알림.
- `components/map-action-menu.ts`, `components/pixel-modal.ts`, `components/map-zoom-controls.ts`: 재사용 가능한 메뉴와 모달의 모양 및 동작.
- `map/world-map.ts`: 지도 composition root. chunk codec, 제스처, 캐시, DOM 레이어 코드를 여기로 다시 모으지 않습니다.
- `map/map-snapshot-cache.ts`, `map/map-tile-bitmap-cache.ts`, `map/map-tile-pyramid-renderer.ts`: 이미지 요청과 캐시.
- `map/map-viewport-controller.ts`: 좌표 변환, 제스처, 확대율, 보이는 영역 요청.
- `map/map-entity-layer.ts`와 `map/map-tooltip-controller.ts`: 실시간 마커와 게임 스타일 설명.
- `map/map-player-path-service.ts`, `map/map-route-layer.ts`, `map/map-exploration-mask.ts`: 경로 선택, 탐험 mask, 경로선.

composition root는 컴포넌트를 만들고 서로 연결하는 객체입니다. codec은 데이터를 인코딩하거나 디코딩합니다. 파일은 이동할 수 있으므로 `web/src`에서 현재 위치를 검색하세요. 파일 위치가 바뀌어도 각 컴포넌트는 좁고 명확한 책임을 가져야 합니다.

## 성능과 Safari/iOS

- 확대할 때 월드 전체 크기의 거대한 canvas/bitmap을 만들지 않습니다. 보이는 chunk만 처리하고 상세 이미지가 준비될 때까지 개요 레이어를 유지합니다.
- 상세 레벨이 바뀔 때 이미 그려진 레이어를 비우지 않습니다. 새 이미지가 도착할 때까지 기존 또는 낮은 해상도의 bitmap을 보여 빈 배경이 번쩍이지 않게 합니다.
- 오래된 요청을 취소하고 이전 viewport의 응답을 새 영역에 적용하지 않습니다. pinch 중에는 제스처 중심 근처의 chunk를 우선 요청합니다.
- pinch 애니메이션 중 레이어와 마커의 크기 및 transform을 안정적으로 유지합니다. 확대할 때마다 NPC DOM 스프라이트를 없앴다가 다시 만들지 않습니다.
- bitmap 크기에 적절한 상한을 두고 큰 픽셀 배열을 불필요하게 복사하지 않습니다. iOS Safari의 한도는 데스크톱 브라우저와 다릅니다.
- 이 영역을 수정한 뒤 iOS Safari에서 버튼 확대와 pinch 확대를 각각 확인합니다. 빌드 성공만으로 휴대폰의 깜박임이 사라졌다고 볼 수 없습니다.

## 지도 수정 방법

1. 페이지에서 데이터가 어디서 오는지 확인하고 API와 캐시까지 흐름을 따라갑니다.
2. 큰 지도는 필요한 영역만 요청합니다. 캐시 키에는 월드, 버전, 프로필, 상세 레벨, 좌표를 포함합니다.
3. 큰 데이터는 간결한 live snapshot과 별도로 요청합니다. 전체 기록을 자주 반복하는 polling에 넣지 않습니다.
4. 사용자 설정은 브라우저에 저장하고 서버 간격, 기능 사용 가능 여부, 기록 기간은 서버 설정에 둡니다.
5. 새 UI에는 재사용 컴포넌트와 기존 픽셀 디자인 token을 사용하고 키보드와 모바일 입력도 고려합니다.
6. 프로토콜을 바꾸면 TypeScript consumer, backend handler/store, 모드 producer를 함께 수정합니다.
7. TypeScript/SCSS를 바꾸면 `npm run build`로 assets를 다시 생성합니다.

## 현재 한계

지도는 PNG chunk로 전송됩니다. 타일 배열은 이미지 재생성과 tooltip에 필요한 서버 기준 데이터로 남습니다. 탐험하지 않은 실제 지형은 클라이언트에 보내지 않고 서버에서 가립니다. 실시간 엔티티는 최신 모드 snapshot에 의존하며, 오래된 snapshot의 좌표는 표시하지 않습니다.
