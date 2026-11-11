# tMapOnline 서버 모드

모드 이름은 `tMapOnline`입니다. 서버 tModLoader 안에서 실행되므로 플레이어가 따로 설치할 필요가 없습니다. 게임 데이터를 웹 서비스로 보내고 Map Ping을 양방향으로 전달합니다.

## 모드의 역할

모드는 지도를 그리거나 웹사이트를 실행하지 않습니다. 플레이어의 현재 위치 같은 게임 데이터를 읽어 tMapOnline 애플리케이션으로 보냅니다. 애플리케이션은 데이터를 저장하고 브라우저에 표시합니다. 브라우저에서 Map Ping을 놓으면 게임에 나타나며, 게임에서 놓은 Map Ping은 브라우저에 나타납니다.

## 책임과 경계

모드와 tMapOnline은 `127.0.0.1`의 TCP 연결로 메시지를 주고받습니다. 이 주소는 같은 컴퓨터를 뜻하며 외부 컴퓨터는 이 포트에 접속할 수 없습니다. 메시지는 JSON 한 줄씩입니다. 모드는 웹 서버가 아니며 브라우저 설정을 변경하지 않습니다.

게임 객체는 tModLoader가 월드를 갱신하는 게임 루프 안에서만 안전하게 읽고 수정할 수 있습니다. 네트워크 작업은 이미 준비된 메시지 문자열을 사용하며 별도 작업에서 월드를 직접 읽지 않습니다.

`TMapOnlineSystem`은 모드 시작과 종료를 관리합니다. 게임 이벤트 hook을 연결하고 다른 모듈을 시작하며 주기적으로 snapshot을 만들고 Map Ping을 받고 종료 시 연결을 닫습니다.

| 책임                                                      | 컴포넌트                                           |
| --------------------------------------------------------- | -------------------------------------------------- |
| TCP listener, 클라이언트, JSONL, snapshot 확인, 수신 명령 | `TelemetryStreamServer`                            |
| NPC와 월드 entity snapshot                                | `WorldEntitySnapshotBuilder`                       |
| 플레이어 외형과 모드 텍스처 내보내기                      | `PlayerAppearanceSnapshotBuilder`                  |
| 지도 스캔 및 RGB/RGBA 타일 변경                           | `WorldMapScanner`, `MapTileDataCapture`            |
| 타일/벽 이름과 현지화                                     | `MapTileNameCatalog`                               |
| 플레이어 지도 탐험 영역 감지                              | `PlayerMapChangeRevealer`                          |
| 바닐라 승리 플래그와 이전 카운터                          | `BossProgressSnapshotReader`, `BossVictoryTracker` |
| Calamity 전용 연동                                        | `CalamityBossProgressAdapter`                      |

RGB는 픽셀의 빨강, 초록, 파랑 값이고 RGBA는 투명도를 추가합니다. `CalamityBossProgressAdapter`는 Calamity 지원에만 필요하며 나머지 보스 진행 처리는 이에 의존하지 않습니다. 표의 이름은 소스 코드와 같습니다. 게임 월드 읽기/수정은 게임 루프에 두고 네트워크 작업에는 준비된 메시지만 전달하세요.

## 전송과 신뢰성

- 기본 listener는 `127.0.0.1:38762`만 기다립니다. 설정은 `server.telemetry_host`, `server.telemetry_port`입니다.
- snapshot은 JSON Lines, schema version `1`입니다. 각 줄에 `snapshotId`가 있고 tMapOnline은 동일 TCP 연결로 확인을 보냅니다.
- 사망 이벤트는 안정적인 ID를 사용하고 확인될 때까지 재전송하며 `storage.death_retention_seconds`로 제한됩니다.
- tMapOnline 클라이언트는 연결이 끊기면 재접속합니다. listener는 최신 상태를 유지해 새 클라이언트에 바로 snapshot을 보냅니다.
- 웹 Map Ping은 타일 좌표가 포함된 명령이며 모드가 연결된 플레이어에게 전송합니다. 게임 Map Ping은 타일 좌표가 포함된 이벤트로 돌아옵니다.
- 브라우저 표시 설정은 모드로 전송하지 않습니다. 전송 간격과 ping 방향은 서버 시작 설정에서 정합니다.

연결 방향을 기억하세요. 모드가 포트를 열고 대기하며 Python 서비스가 접속합니다. 연결 후 양쪽 모두 메시지를 보낼 수 있습니다. 서비스는 Map Ping과 확인을 보내고 모드는 snapshot과 게임 이벤트를 보냅니다.

스키마와 endpoint는 [telemetry.md](telemetry.md)를 참고하세요. 필드의 의미나 유형을 바꾸면 새 schema 버전과 호환 기간을 사용하고 v1을 조용히 변경하지 마세요.

## 빌드

프로젝트 루트에서 실행합니다. macOS에서는 설치된 tModLoader 경로를 `TML_ROOT`로 지정합니다.

```sh
TML_ROOT="/path/to/tModLoader" python3 tools/build-mod.py
```

`/path/to/tModLoader`를 실제 게임 경로로 바꾸세요. 스크립트는 C# 프로젝트를 빌드해 `dist/tMapOnline.tmod`를 만듭니다. 별도 임시 폴더를 사용하므로 프로필 설정은 변경되지 않습니다. 모드를 설치하거나 실행 중인 서버 파일을 건드리지 않습니다. 빌드와 서버의 tModLoader 버전은 같아야 합니다.

서버에서 모드를 읽으려면 `.tmod`를 서버 프로필의 `Mods` 폴더로 복사하고 모드 ID를 활성화 목록 `Mods/enabled.json`에 추가합니다. 다음 서버 시작 때 모드가 로드됩니다. 플레이어가 나간 뒤 재시작하세요.

## 모드 수정

1. `TMapOnlineSystem`에서 필요한 이벤트 handler를 찾습니다. 로직이 많으면 책임이 분명한 별도 클래스로 옮깁니다.
2. 메시지 송신자부터 Python 서비스 수신자까지 흐름을 확인합니다.
3. Terraria API는 게임 루프 안에서 읽습니다. 네트워크 작업에는 준비된 메시지를 전달합니다.
4. 중요한 이벤트에 고유 ID를 붙이고 서비스가 확인할 때까지 재전송합니다.
5. 대상 tModLoader 버전에 맞춰 `python3 tools/build-mod.py`로 빌드합니다.
6. 별도의 설치/실행 요청이 없으면 실행 중인 서버 프로필에 `.tmod`를 복사하거나 서버를 재시작하지 않습니다.

이벤트 handler는 블록 변경처럼 게임 이벤트에 반응해 실행되는 코드입니다. 고유 ID를 통해 서비스가 이미 받은 이벤트를 알아보고 재전송 중복을 방지합니다.
