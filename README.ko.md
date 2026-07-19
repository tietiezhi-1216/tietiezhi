<div align="center">

<img src="./assets/brand/tietiezhi-mark-transparent.png" alt="Tietiezhi 문어 로고" width="120">

# Tietiezhi · 铁铁汁

**모든 기기를 모든 AI 모델과 연결합니다.**

macOS, Windows, Linux, iOS, Android, 서버와 엣지 노드를 잇는 개방형 에이전트 네트워크입니다.

[简体中文](./README.md) · [English](./README.en.md) · [日本語](./README.ja.md) · [한국어](./README.ko.md)

[⬇️ macOS / Windows 다운로드](https://tietiezhi-1216.github.io/tietiezhi/) · [📦 릴리스](https://github.com/tietiezhi-1216/tietiezhi/releases/latest) · [🗺️ 로드맵](./docs/ROADMAP.en.md) · [🔒 개인정보 보호](./docs/PRIVACY.md) · [💬 Issues](https://github.com/tietiezhi-1216/tietiezhi/issues) · [⚖️ Apache-2.0](./LICENSE)

</div>

<div align="center">

<img src="./docs/images/tietiezhi-choose-model.jpg" alt="모델을 선택하기 전의 Tietiezhi 데스크톱" width="860">

<sub>공급자를 연결한 뒤 새 작업에 적합한 모델을 사용자가 선택</sub>

</div>

## Tietiezhi란?

Tietiezhi는 **기기 × 모델 상호 연결**을 중심으로 하는 오픈 소스 AI 프로젝트입니다. 모든 작업을 한 컴퓨터, 하나의 채팅 창, 하나의 모델에 몰아넣는 대신 데스크톱, 모바일 클라이언트, 독립 서버 바이너리, 엣지 기기를 하나의 협업 에이전트 네트워크로 연결하는 것을 목표로 합니다.

추론, 코딩, 음성, 이미지, 동영상, 저지연 처리처럼 모델마다 잘하는 일이 다릅니다. Tietiezhi는 기기와 작업에 맞는 모델, 도구, 컨텍스트를 연결해 각 모델이 가장 잘하는 역할을 맡도록 합니다.

현재 배포된 제품은 **macOS 13.3 이상**과 **Windows 10/11(x64)**용 데스크톱 에이전트입니다. Go Server는 Hub와 기기 연결 기반을 제공합니다. Linux, iOS, Android 클라이언트와 완전한 기기 간 협업은 로드맵에 있으며 아직 완성 제품으로 배포되지 않았습니다.

## 하나의 네트워크에서 각 모델의 강점을 활용

| 계층 | 현재 기반 | 발전 방향 |
| --- | --- | --- |
| 기기 | macOS / Windows 데스크톱 | Linux, iOS, Android, 독립 바이너리, 엣지 노드 |
| Hub | Go 단일 바이너리와 기기 등록·메시지 라우팅 기반 | 로컬 sidecar / 원격 Hub를 통한 검색, 상태 동기화, 작업 전달 |
| 모델 | 여러 OpenAI 호환 서비스, 텍스트, 음성 인식 | 추론, 코드, 음성, 이미지, 동영상, 음악, 임베딩 모델의 기능 라우팅 |
| Agent | 로컬 도구, 권한, Skills, MCP, 격리 작업 공간 | 기기 간 협업, 위임, 자동화, 통합 실행 기록 |

## 현재 사용 가능한 데스크톱 기능

| 기능 | 현재 구현 |
| --- | --- |
| 여러 모델 서비스 | Tietiezhi Gateway 또는 여러 OpenAI 호환 서비스를 추가하고 모델을 동기화·전환 |
| 로컬 에이전트 | 스트리밍 대화, 다단계 도구 호출, 시스템 프롬프트, 재사용 가능한 에이전트 프로필 |
| 도구와 권한 | 파일, 편집, 검색, 셸, 네트워크 가져오기 도구와 3단계 권한 모드 |
| Skills와 MCP | Markdown 기반 Skills 및 stdio / Streamable HTTP MCP 서버 지원 |
| 프로젝트와 작업 | 로컬 기록과 작업 공간, 고정, 보관, Git 저장소용 격리 worktree |
| 음성 받아쓰기 | 전역 단축키, 음성 인식, 모델 기반 문장 다듬기, 현재 앱에 텍스트 삽입 |
| 로컬 우선 | API Key는 macOS Keychain / Windows Credential Manager에 저장되며 광고, 추적, 원격 측정 없음 |

## 빠른 시작

1. [웹사이트](https://tietiezhi-1216.github.io/tietiezhi/) 또는 [GitHub Releases](https://github.com/tietiezhi-1216/tietiezhi/releases/latest)에서 설치 파일을 받습니다.
2. **설정 → 공급자**에서 Tietiezhi Gateway를 사용하거나 OpenAI 호환 `baseURL`과 API Key를 추가합니다.
3. 모델을 동기화하고 선택한 뒤 새 작업을 만듭니다. 로컬 저장소가 필요하면 프로젝트 폴더를 선택합니다.
4. 필요에 따라 에이전트, Skills, MCP 서버, 도구 권한을 설정합니다.

> Tietiezhi에는 개인 API Key가 포함되어 있지 않습니다. 외부 모델의 요금과 데이터 처리 규정은 각 서비스 제공자가 정합니다.

## 언어

README와 공식 웹사이트는 중국어 간체, 영어, 일본어, 한국어를 지원합니다. 데스크톱 앱 UI는 현재 중국어 간체 중심이며 앱 전체 국제화는 단기 로드맵에 포함되어 있습니다. 번역을 개선하는 Pull Request도 환영합니다.

## 로드맵

현재 데스크톱 에이전트를 시작으로 기기는 상황과 실행 환경을 제공하고, 모델은 전문 기능을 제공하며, Agent가 명확한 권한 아래 둘을 연결하는 **사용자 주도 기기·모델 네트워크**로 발전하는 것이 목표입니다.

단기적으로 앱 국제화, macOS / Windows 안정성·서명·업데이트, 여러 공급자 연결, 도구 승인, Skills / MCP, 작업과 작업 공간 경험을 개선합니다. 다음 단계에서는 `server/` 통합 방식, 기기 연결, 사용량·비용 정보를 다룹니다. 장기적으로는 멀티 에이전트, Codex / Claude Code / opencode 연동, 멀티모달 모델, 시각적 워크플로와 자동화를 지향합니다.

자세한 내용은 [영문 로드맵](./docs/ROADMAP.en.md)을 참고하세요.

## 저장소 구성

| 경로 | 설명 |
| --- | --- |
| [`desktop/`](./desktop) | Tauri 2 + Rust + React 19 + TypeScript 기반 데스크톱 앱 |
| [`server/`](./server) | OpenAI 호환 API, 채널, 메모리, 스케줄링, 기기 연결 기반을 제공하는 Go Agent Hub |
| [`website/`](./website) | 다국어 공식 웹사이트와 다운로드 페이지 |
| [`assets/brand/`](./assets/brand) | 로고, 마스코트, 앱 아이콘 원본 |
| [`docs/`](./docs) | 로드맵, 개인정보 보호, 코드 서명 문서 |

## 개발

데스크톱 앱 개발에는 Node.js 22+, pnpm 9+, Rust stable 및 운영 체제별 Tauri 시스템 의존성이 필요합니다.

```bash
cd desktop
pnpm install
pnpm tauri dev
```

기여하기 전에 저장소 개발 규칙인 [`CLAUDE.md`](./CLAUDE.md)를 읽어 주세요. 버그와 제안은 [Issues](https://github.com/tietiezhi-1216/tietiezhi/issues)에 남길 수 있습니다. 공개 Issue에 API Key나 민감한 정보를 게시하지 마세요.

## 라이선스

Copyright © 2026 Tietiezhi. [Apache License 2.0](./LICENSE)에 따라 배포됩니다. 데이터 처리에 관한 내용은 [개인정보 보호정책](./docs/PRIVACY.md)을 참고하세요.
