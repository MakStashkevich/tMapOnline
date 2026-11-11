# tMapOnline 업데이트

이 문서는 웹 지도, Python 서비스(backend), 서버 모드 `tMapOnline`을 업데이트하는 방법을 설명합니다. 프로그램을 교체해도 저장된 월드, 플레이어 기록, 보스 진행은 지우지 않습니다.

## 프로젝트 구성

- Python 패키지와 실행 명령은 `tmaponline`입니다.
- macOS LaunchAgent는 로그인할 때 프로젝트 가상 환경의 `tmaponline`을 실행하는 시스템 서비스입니다.
- 서버 모드 소스와 ID는 `tMapOnline`입니다.
- 새 빌드 결과물은 `tMapOnline.tmod`입니다.

소스를 변경한 뒤 새 패키지를 빌드해 tModLoader 프로필에 설치합니다. 프로필은 모드와 월드가 분리된 tModLoader 설치입니다. 모드를 교체하기 전에 플레이어가 접속을 끊었는지 확인하고 월드와 활성 모드 목록을 백업하세요.

## 사용자 데이터

기본적으로 웹 지도와 모드 데이터는 `~/Library/Application Support/tMapOnline`에 저장됩니다. `~`는 현재 사용자의 홈 폴더를 뜻합니다. 이 디렉터리에는 월드 데이터, 플레이어 기록, 이미지 캐시, 보스 승리 진행이 저장된 `boss-victories.json`이 있습니다. 업데이트할 때 이 디렉터리를 삭제하지 마세요. `storage.data_dir`를 바꾸면 먼저 파일을 새 위치로 옮기고 프로그램이 읽을 수 있는지 확인하세요.

## 업데이트 버전 설치 및 실행

프로젝트 루트에서 명령을 실행하세요. Python 환경은 tMapOnline 라이브러리를 다른 프로그램과 섞이지 않도록 별도 폴더에 둡니다.

1. 환경을 만들거나 활성화하고 현재 디렉터리에서 설치합니다: `python3 -m pip install -e .`. `-e`는 Python이 이 위치의 소스를 직접 쓰게 하므로 코드 수정 후 패키지를 다시 빌드하지 않아도 됩니다.
2. `tmaponline --config config.local.yaml serve` 또는 `tmaponline --config config.local.yaml run`으로 지도를 실행합니다. `--config`는 설정 파일을 지정합니다. `serve`는 웹 서비스만 시작하고 `run`은 설정된 게임 서버도 시작합니다.
3. 설치된 tModLoader 버전에 맞춰 모드를 빌드합니다: `TML_ROOT="/path/to/tModLoader" python3 tools/build-mod.py`.
4. `dist/tMapOnline.tmod`를 테스트 프로필이나 월드 복사본에서 확인합니다. 빌드는 파일만 만들며 서버 프로필에 자동 설치하지 않습니다.
5. 모드를 교체하기 전에 플레이어가 모두 나갔는지 확인하고 월드, 이전 `.tmod`, 활성 모드 목록을 저장합니다.
6. `tMapOnline.tmod`를 서버 프로필에 복사하고 모드를 켠 뒤 플레이어가 없을 때 서버를 재시작합니다.
7. `/healthz`로 서비스 응답을, `/api/site-config`로 기능 설정을, `/api/status`로 서버 상태를 확인합니다. 이어서 지도, 최신 게임 데이터, 양방향 Map Ping을 확인합니다.

## 롤백

새 빌드가 시작되지 않으면 정상적으로 중지하고 이전 `.tmod`, 활성 모드 목록, 이전 서비스 빌드를 복구합니다. 롤백은 저장된 정상 버전으로 되돌리는 작업입니다. tMapOnline 데이터 디렉터리는 삭제하지 마세요.
