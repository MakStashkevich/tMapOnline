# 텔레메트리와 API

텔레메트리는 모드가 웹 서비스에 자동 전송하는 게임 데이터입니다. 서비스는 데이터를 받고 검증하고 필요한 기록을 저장해 브라우저용 응답을 만듭니다. Map Ping도 같은 연결을 통해 게임에서 브라우저로, 브라우저에서 게임으로 전달됩니다.

## 모드 데이터 스트림

모드는 `server.telemetry_host` 주소에서 `server.telemetry_port`를 열고 연결을 기다립니다. Python 클라이언트가 TCP(프로그램 간 네트워크 연결)로 접속하면 모드가 데이터를 보냅니다. JSON 한 줄이 레코드 하나인 JSONL 형식입니다. `schemaVersion: 1`은 레코드 규칙 버전을 뜻합니다. 레코드에는 서버, 월드, 플레이어, NPC, 지도 객체 상태가 담깁니다. 연결이 끊기면 Python 클라이언트가 자동 재접속을 시도하고 잘못된 줄은 건너뛰어 계속 읽습니다.

각 완전한 레코드(snapshot, 현재 상태 기록)에는 `snapshotId`가 있습니다. Python 클라이언트가 읽고 저장하면 수신 확인 ACK를 보냅니다: `{"ackSnapshotId":123}`. 사망 이벤트는 snapshot 사이에 발생할 수 있어 별도의 `id`가 있습니다. 모드는 확인되지 않은 이벤트를 재전송하며 ACK를 받은 후에만 대기열에서 지웁니다. 마커 보존 기간은 `storage.death_retention_seconds`로 정하고 `0`은 자동 정리를 끕니다.

플레이어와 NPC는 `Player.direction`, `NPC.spriteDirection`의 방향을 보내 브라우저가 스프라이트를 올바르게 좌우 반전할 수 있게 합니다. 선택 필드 `respawnPending`은 플레이어가 아직 죽어 있거나 부활 후 좌표가 갱신되지 않았음을 나타냅니다. 값이 `true`인 동안 지도는 이전 위치의 일반 플레이어 마커를 숨기고 사망 십자만 남깁니다.

payload는 모드가 보내는 레코드 내용입니다. 호환되는 변경은 선택 필드를 추가하면 이전 수신자가 무시할 수 있습니다. 기존 필드의 의미나 유형을 바꾸면 schema 버전을 올리고 전환 기간 동안 구버전과 신버전을 모두 읽도록 해야 합니다. 비밀번호, 토큰 등 비밀 정보를 메시지에 넣지 마세요.

## HTTP endpoints

HTTP는 브라우저가 서버에 페이지나 데이터를 요청하는 일반적인 방식입니다. `GET`은 읽기, `POST`는 보내기, `DELETE`는 지정 데이터 삭제입니다. `?` 뒤에는 쿼리 매개변수가 옵니다. 예를 들어 `x=10&y=20`은 타일 좌표입니다. 아래 `x`, `y`는 게임 타일 단위입니다.

경로에서 `id`는 플레이어 ID, `world`는 월드 이름, `days`는 기록 일수, `since`는 그 이후의 새 변경만 요청하는 기준입니다. feature flag는 기능의 사용 가능 여부를 UI에 알립니다.

| Endpoint                                                   | 용도                                                  |
| ---------------------------------------------------------- | ----------------------------------------------------- |
| `GET /api/status`                                          | 서버, 플레이어, 보스, 기록 요약.                      |
| `GET /api/world-map`                                       | 전체 픽셀 chunk가 없는 메타데이터와 레이어.           |
| `GET /api/world-map?tiles=0`                               | 픽셀 chunk를 포함한 호환 전체 지도 JSON.              |
| `GET /api/world-map?since=...`                             | 지도 변경분.                                          |
| `GET /api/world-map/tile-info?x=...&y=...`                 | 현지화된 블록/벽 설명.                                |
| `GET /api/world-map/exploration?id=...&world=...`          | 플레이어 탐험 이미지.                                 |
| `POST /api/world-map/import-player-map?id=...`             | debug 페이지에서 `.map`을 가져와 새 탐험 타일을 병합. |
| `POST /api/world-map/export-player-map?id=...`             | 저장된 정보에서 `.map` 내보내기.                      |
| `DELETE /api/world-map/import-player-map?id=...&world=...` | 가져온 지도 부분만 삭제.                              |
| `GET /api/resource-history?days=...`                       | 서버 리소스 기록.                                     |
| `GET /healthz`                                             | HTTP 서버 연결 로컬 확인.                             |
| `GET /api/site-config`                                     | UI 기능 플래그.                                       |

정적 UI 파일(CSS, JavaScript, 고정 이미지)은 `/assets/`에 있습니다. 플레이어, NPC, 보스 이미지는 데이터 디렉터리에서 별도 API 주소로 제공합니다.

주소를 직접 확인하려면 브라우저에서 열거나 명령줄 요청을 보냅니다. 먼저 `/healthz`로 HTTP 서비스가 응답하는지 확인하세요. 이것만으로 모드 연결이나 지도 수신이 확인되지는 않으므로 `/api/status`와 `/api/world-map`도 확인해야 합니다.
