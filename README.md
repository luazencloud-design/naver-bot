# 🤖 KakaoClassBot (kakao-bot)

> **카카오톡 채널에서 동작하는 RAG 챗봇 — PDF/PPTX/HWP/MP4/MP3/VTT 등을 지식 베이스로 사용**
> 사용자가 카카오톡으로 질문하면, 등록된 자료에서 관련 내용을 검색해 Gemini가 출처와 함께 답변합니다.

- **GitHub:** [luazencloud-design/naver-bot](https://github.com/luazencloud-design/naver-bot)  *(repo 이름은 naver-bot, 실제 용도는 kakao-bot)*
- **기술 스택:** Express · Vercel Serverless · Google Gemini API · pdf-parse · officeparser · hwp.js
- **현재 도메인:** 사업자등록 및 운영 안내 (시스템 프롬프트가 도메인 특화 — 다른 주제로 쓰려면 프롬프트 수정 필요)

---

## 📋 목차

1. [한눈에 보는 구조](#-한눈에-보는-구조)
2. [파일 구성](#-파일-구성)
3. [코드 원리](#-코드-원리)
4. [지원하는 파일 형식](#-지원하는-파일-형식)
5. [다운로드 방법](#-다운로드-방법)
6. [외부 서비스 연동](#-외부-서비스-연동)
7. [설치 & 첫 셋업](#-설치--첫-셋업)
8. [일상 운영 — 자료 추가/갱신](#-일상-운영--자료-추가갱신)
9. [환경변수 (.env)](#-환경변수-env)
10. [npm 스크립트](#-npm-스크립트)
11. [트러블슈팅](#-트러블슈팅)
12. [후임자 메모 — 알려진 제약과 개선 로드맵](#-후임자-메모--알려진-제약과-개선-로드맵)

---

## 🗺 한눈에 보는 구조

```
[사용자]               [카카오 i 오픈빌더]            [Vercel 서버리스]
   │                          │                              │
   ├─ 카카오톡에 질문 ──────►  │                              │
   │                          ├─ 폴백 블록 → 스킬 호출 ──►   │
   │                          │                              ├─ src/rag.js
   │                          │                              │   ├─ Gemini로 질문 임베딩 (768차원)
   │                          │                              │   ├─ data/chunks.json에서
   │                          │                              │   │  코사인 유사도 TOP_K (기본 4)
   │                          │                              │   └─ Gemini가 답변 생성 (3회 재시도)
   │                          │   ◄──── 카카오 응답 포맷 ────┤
   │   ◄──── 답변 + 📚출처 ───┤                              │
```

지식 베이스(`data/chunks.json`)는 로컬에서 한 번 만들고 GitHub에 commit하면 Vercel이 자동 재배포해 챗봇이 새 내용을 답변합니다.

---

## 📁 파일 구성

```
kakao-bot/
├── api/
│   └── index.js                # Vercel 서버리스 진입점 (Express app 재내보내기)
│
├── src/
│   ├── app.js                  # Express 라우트 (sync + callback 엔드포인트)
│   │                            # GET / → health check {"status":"ok"}
│   │                            # POST /kakao/skill (sync, 5초 안에 응답)
│   │                            # POST /kakao/skill/callback (대용량 답변용)
│   ├── server.js               # 로컬 dev .listen() (npm run dev)
│   ├── rag.js                  # 임베딩 + 코사인 검색 + Gemini 답변 (3회 재시도)
│   └── kakao.js                # 카카오 응답 포맷 헬퍼 (version: '2.0')
│
├── scripts/
│   ├── ocr.js                  # source-files/ → 텍스트 추출 → data/extracted/ 캐시
│   │                            #   - PPTX는 PowerPoint COM으로 PDF 변환 후 처리
│   │                            #   - 이미지/스캔본/오디오/영상은 Gemini Files API OCR
│   │                            #   - mtime 비교로 캐시 stale 자동 감지
│   │                            #   - 5회 재시도 (15초씩 대기)
│   ├── ingest.js               # 캐시된 텍스트 → 청킹(800자/100자 overlap)
│   │                            #   → 임베딩 → data/chunks.json
│   │                            #   - 청크 간 150ms 지연 (rate limit 회피)
│   ├── test-rag.js             # 로컬 RAG 테스트 (서버 없이 답변 품질 확인)
│   └── lib/
│       ├── hwp-extract.js      # HWP 5.x 텍스트 추출 (2.x/3.x 미지원)
│       ├── vtt-extract.js      # WebVTT 자막 파서 (타임스탬프/화자라벨 제거)
│       ├── pptx-to-pdf.js      # PowerShell 호출 래퍼 (5분 타임아웃)
│       └── pptx-to-pdf.ps1     # PowerPoint COM 자동화 (ReadOnly + Untitled로 SaveAs 프롬프트 회피)
│
├── source-files/               # 🚫 GitIgnored. 원본 자료 (PDF/PPTX/HWP/MP3/MP4/VTT/TXT)
│   └── .gitkeep
├── data/
│   ├── chunks.json             # 임베딩된 지식 베이스 (Vercel이 런타임에 사용)
│   └── extracted/              # 🚫 GitIgnored. OCR/추출 캐시
│
├── .env                        # 🚫 GitIgnored. API key 등 민감 정보
├── .env.example                # .env 작성 템플릿
├── .vercelignore               # scripts/ 등 배포 제외 (chunks.json만 포함)
├── package.json                # express, dotenv, hwp.js, officeparser, pdf-parse
├── vercel.json                 # maxDuration: 30, includeFiles: data/chunks.json
├── update.bat                  # 원클릭 5단계: ocr → ingest → git commit → push
├── IMPROVEMENTS.md             # 개선 로드맵 (P0/P1/P2)
└── README.md                   # 이 문서
```

---

## 🧬 코드 원리

### A. RAG 파이프라인 (`src/rag.js`)

```
질문 텍스트
   │
   ▼
[1] Gemini 임베딩 (gemini-embedding-001, 768차원)
   │
   ▼
[2] data/chunks.json 메모리 로드 (콜드스타트 1회만)
   │  └ 각 청크는 { text, source, embedding[768] } 형식
   ▼
[3] 코사인 유사도 계산 → TOP_K 청크 추출 (기본 4개)
   │
   ▼
[4] 시스템 프롬프트 + 청크 + 질문 → Gemini 답변 생성
   │  (3회 재시도, 800ms × attempt 백오프)
   │  - 자료에 없으면 "해당 정보는 제공된 자료에 포함되어 있지 않습니다"
   │  - 답변 끝에 "📚 출처: <파일명>" 형식 강제
   ▼
답변 (카카오 응답 포맷으로 변환 → src/kakao.js)
```

### B. 데이터 준비 파이프라인 (`update.bat` 5단계)

```
source-files/<파일>          (사용자가 드롭하는 원본)
        │
        ▼  [1/5] npm run ocr (scripts/ocr.js)
data/extracted/<stem>.txt    (텍스트 캐시. mtime 비교로 stale 자동 감지)
        │
        │   - PPTX → PowerPoint COM으로 PDF 자동 변환
        │   - 스캔/이미지 PDF → Gemini Files API OCR (5회 재시도, 15초씩 대기)
        │   - MP3/MP4 → Gemini Files API 음성/영상 전사 (5분 polling)
        │   - HWP → hwp.js 로컬 파싱 (5.x만)
        │   - VTT → 정규식 파서 (타임스탬프/25자 이내 화자 라벨 제거)
        │
        ▼  [2/5] npm run ingest (scripts/ingest.js)
data/chunks.json             (청킹 800자/100자 overlap + 768차원 임베딩)
        │
        │   - 청크 10개마다 진행 출력
        │   - 청크 간 150ms 지연 (무료 티어 rate limit 회피)
        │   - 임베딩 5회 재시도
        │
        ▼  [3/5] git add data/chunks.json
        ▼  [4/5] git commit -m "Update knowledge base"
        ▼  [5/5] git push                 → Vercel 자동 재배포 (~60초)
```

### C. 시스템 프롬프트 (`src/rag.js` 줄 180~193)

> ⚠️ **현재 도메인 특화:** "당신은 사업자등록 및 운영 안내 챗봇입니다." 가 하드코딩되어 있습니다. 다른 주제(예: 일반 강의)에 사용하려면 이 프롬프트를 수정하세요.

규칙:
- 제공된 청크에 답이 없으면 정확히 "해당 정보는 제공된 자료에 포함되어 있지 않습니다"
- 답변 끝에 `📚 출처: <파일명>` 형식 강제
- 사용자 질문(`question`)은 변수로 격리되어 시스템 프롬프트와 분리됨 (프롬프트 인젝션 기초 방어)

### D. Vercel callback 모드 제약 (중요!)

`POST /kakao/skill/callback`은 카카오의 콜백 패턴을 위해 만들어졌지만 **Vercel serverless에서는 백그라운드 작업 완료가 보장되지 않습니다**. `res.json()` 이후 함수가 종료될 수 있어 callback POST가 실패할 수 있습니다.

해결책 (IMPROVEMENTS.md P0):
- `@vercel/functions`의 `waitUntil()` 사용
- 또는 Fly.io / Render / Railway 같은 항상 켜진 호스트로 마이그레이션

`callbackUrl`이 비어있으면 자동으로 동기 응답으로 fallback 합니다.

---

## 📂 지원하는 파일 형식

| 확장자 | 처리 방식 | Gemini API 호출 | 비용 | 추가 도구 |
|---|---|---|---|---|
| `.pdf` | 텍스트 PDF: pdf-parse · 스캔본: Gemini OCR | OCR 시 | OCR 시만 | 없음 |
| `.pptx` | PowerPoint COM → PDF 자동 변환 → PDF 파이프라인 | 변환된 PDF에 OCR | OCR 시만 | **PowerPoint 필수** |
| `.txt` | `fs.readFileSync` 직접 | 안 함 | 무료 | 없음 |
| `.hwp` | hwp.js 로컬 파싱 | 안 함 | 무료 | HWP 5.x만 |
| `.vtt` | 정규식 파서 (타임스탬프/화자 라벨 제거) | 안 함 | 무료 | 없음 |
| `.mp3` | Gemini Files API 음성 전사 (5분 polling) | 호출 | 발생 | 없음 |
| `.mp4` | Gemini Files API 영상 전사 + 화면 텍스트 | 호출 | 발생 | 없음 |

**권장 시나리오:**
- **단순 본문**: PDF / TXT / HWP — 추가 비용 없이 바로 처리
- **Zoom 강의 녹화**: VTT 자막 사용 추천 (5시간 강의도 즉시, 비용 0)
- **이미지 많은 PPT**: 자동 PDF 변환 → Gemini OCR
- **음성 강의**: 길면 VTT 추출이 가장 효율적, 짧으면 MP3/MP4 직접

---

## 📥 다운로드 방법

```powershell
cd "C:\Users\<본인이름>\Desktop"
git clone https://github.com/luazencloud-design/naver-bot.git kakao-bot
cd kakao-bot
```

Git 미설치 시: GitHub repo → **Code → Download ZIP** → 압축 풀기.

---

## 🔑 외부 서비스 연동

### 1. Gemini API Key (필수)

[aistudio.google.com/apikey](https://aistudio.google.com/apikey)에서 무료 발급. `AIza...`로 시작.

**무료 한도:** 분당 15회 / 일 1,500회 — 일반 운영에 충분.

### 2. 카카오 i 오픈빌더 (필수)

1. [i.kakao.com](https://i.kakao.com) → 오픈빌더 봇 생성
2. **시나리오 → 폴백 블록**에 스킬 추가
3. 스킬 URL: `https://your-vercel-domain.vercel.app/kakao/skill`
4. 메서드: `POST`
5. 카카오톡 채널과 연동

### 3. Vercel (필수)

배포 후 환경변수 `GEMINI_API_KEY` 설정 (아래 설치 단계 참고).

### 4. Microsoft PowerPoint (PPTX 사용 시)

PPTX 자동 PDF 변환에 필수. 없으면 PPTX 처리 시 에러.

---

## 🛠 설치 & 첫 셋업

### 사전 준비

| 항목 | 필요 여부 | 비고 |
|---|---|---|
| **Windows OS** | 필수 | PPTX → PDF 변환에 PowerPoint COM 사용 |
| **Node.js 18+** | 필수 | [nodejs.org](https://nodejs.org) LTS |
| **PowerPoint** | PPTX 사용 시 필수 | 자동 PDF 변환용 |
| **Git** | 권장 | clone/push용 |

### 1. 의존성 설치

```powershell
npm install
```

→ 약 1~2분. `node_modules/` 자동 생성 (GitHub에는 안 올림).

### 2. 환경변수 작성

```powershell
copy .env.example .env
notepad .env
```

```env
GEMINI_API_KEY=AIza...     # 본인 Gemini API key
```

나머지 (`GEMINI_MODEL`, `EMBED_MODEL`, `TOP_K`, `PORT`, `SOURCE_FILE`)는 기본값 OK.

### 3. 소스 자료 배치

`source-files/`는 GitHub에 안 올라갑니다. 전임자에게서 받은 자료를 직접 복사:

```
source-files/
├── 사업자등록_안내.pdf
├── 강의1.pptx
├── Zoom녹화_2026-04.vtt
└── ...
```

### 4. 동작 확인

```powershell
node scripts/test-rag.js "사업자등록 절차"
```

답변 + `📚 출처:` 표기가 나오면 성공.

### 5. Vercel 배포

```powershell
vercel        # 처음 한 번 (프로젝트 초기화)
vercel --prod # 프로덕션 배포
```

Vercel **Settings → Environment Variables** 에서 `GEMINI_API_KEY` 추가 후 **Redeploy**.

### 6. 카카오톡 채널 연결

오픈빌더 폴백 블록 → 스킬 URL을 `https://your-vercel.vercel.app/kakao/skill`로 등록.

---

## 🔁 일상 운영 — 자료 추가/갱신

```
1. source-files/ 폴더에 새 파일 드롭 (PDF/PPTX/TXT/HWP/VTT/MP3/MP4)
2. update.bat 더블클릭
3. 끝 — Vercel이 자동으로 ~60초 내 재배포
```

**update.bat 내부 동작:**
- `[1/5]` `npm run ocr` — 신규/수정된 파일만 처리 (mtime 비교, 캐시 활용)
- `[2/5]` `npm run ingest` — chunks.json 재생성
- `[3/5]` `git add data/chunks.json`
- `[4/5]` `git commit -m "Update knowledge base"`
- `[5/5]` `git push` → Vercel 자동 재배포

> **OCR 단계 실패는 경고만 출력하고 계속 진행** (ingest는 캐시된 파일만으로도 동작 가능).
> ingest 실패 시에만 `exit /b 1`로 중단됩니다.

---

## ⚙ 환경변수 (.env)

| 이름 | 필수? | 기본값 | 설명 |
|---|---|---|---|
| `GEMINI_API_KEY` | 필수 | - | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `GEMINI_MODEL` | 선택 | `gemini-flash-lite-latest` | 답변 생성용. 빠르고 503 적게 남 |
| `EMBED_MODEL` | 선택 | `gemini-embedding-001` | 768차원, 한국어 지원 |
| `TOP_K` | 선택 | `4` | 질문당 검색할 상위 청크 수 |
| `PORT` | 선택 | `3000` | 로컬 dev 서버 포트 |
| `SOURCE_FILE` | 선택 | (없음) | 설정 시 그 파일만 처리. 비우면 source-files/ 전체 |

> Vercel 배포는 별도로 **Vercel 대시보드 → Settings → Environment Variables** 설정 필요. 로컬 `.env`와 무관.

---

## 📜 npm 스크립트

| 명령 | 설명 |
|---|---|
| `npm run ocr` | source-files/ → data/extracted/ 캐싱. 캐시된 파일 자동 스킵 |
| `npm run ocr -- --force` | 캐시 무시 전부 재처리 (Gemini 비용 발생) |
| `npm run ingest` | 캐시 텍스트 → 청킹·임베딩 → chunks.json |
| `npm start` | 로컬 dev 서버 (포트 3000) |
| `npm run dev` | 위와 동일 + 파일 변경 시 자동 재시작 (`node --watch`) |

추가 직접 실행:
```powershell
node scripts/test-rag.js "원하는 질문"   # 서버 없이 RAG 테스트
```

---

## 🛠 트러블슈팅

### "정보가 포함되어있지 않습니다" 답변이 자주 나옴
- chunks.json이 비어있거나 stale일 가능성
- `npm run ingest`로 재생성, 안 되면 `npm run ocr -- --force` 후 재시도

### Gemini 503 "high demand"
- 일시적 과부하. 코드에 자동 재시도 포함 (3회, 800ms × attempt)
- 계속되면 `GEMINI_MODEL`을 `gemini-2.5-flash` 또는 `gemini-2.5-pro`로 변경

### PPTX 처리 안 됨
- PowerPoint 설치 확인
- PPTX가 다른 곳(PowerPoint 등)에서 열려 있지 않은지 확인 (`~$파일명.pptx` lock 파일)
- 안 되면 PowerPoint에서 수동 PDF 저장 후 source-files/에 PDF 직접 배치

### 카카오 봇 응답 없음 / "스킬 실행 오류"
- Vercel **Deployments** 탭에서 최근 배포 성공 여부 확인
- Vercel **Logs** 탭에서 실제 에러 확인
- 배포 URL `/`로 접속해 `{"status":"ok",...}` 보이는지 (health check)

### 파일을 수정했는데 답변이 옛날 내용
- mtime 비교 stale 감지가 보통 자동 처리
- 안 되면 `data/extracted/<해당파일>.txt` 삭제 후 update.bat 재실행

### Callback 모드에서 응답이 늦거나 누락됨
- Vercel 환경에서 `res.json()` 후 background 작업이 보장 안 됨
- 동기 모드 `/kakao/skill`로 변경 권장 (5초 안에 응답하도록 짧게)

---

## 📝 후임자 메모 — 알려진 제약과 개선 로드맵

### 인수인계 체크리스트

- [ ] GitHub repo collaborator 권한 받음
- [ ] Vercel 프로젝트 멤버 추가됨
- [ ] 카카오 i 오픈빌더 운영자 추가됨
- [ ] 카카오톡 채널 매니저 추가됨
- [ ] 본인 Gemini API key 발급
- [ ] Vercel 환경변수 `GEMINI_API_KEY` 본인 키로 교체 + Redeploy
- [ ] source-files/ 자료 별도 전달받음 (USB/클라우드 드라이브)
- [ ] 로컬에서 `npm install` + `node scripts/test-rag.js` 동작 확인
- [ ] update.bat 1회 실행해 전체 파이프라인 검증
- [ ] 카카오 봇 테스트 패널에서 실제 질의응답 확인

### 알려진 제약

1. **Vercel 콜백 모드 불안정** — Fly.io/Render 마이그레이션 검토 (IMPROVEMENTS.md P0)
2. **HWP 2.x/3.x 미지원** — HWP 5.x만 (`hwp.js` 한계)
3. **PPTX 처리에 PowerPoint 필수** — 리눅스 서버에서는 LibreOffice로 대체 필요
4. **chunks.json이 GitHub에 들어감** — 200MB 한계, 자료 많으면 Supabase pgvector 등 외부화 필요 (P1)
5. **시스템 프롬프트 도메인 특화** — "사업자등록" 하드코딩, 다른 도메인은 `src/rag.js` 줄 180~193 수정

### 자주 변경되는 곳

| 변경 항목 | 위치 |
|----------|------|
| 시스템 프롬프트 (도메인) | `src/rag.js` 줄 180~193 |
| 청크 크기 / 겹침 | `scripts/ingest.js` `chunkText(text, 800, 100)` |
| TOP_K (검색 청크 수) | `.env`의 `TOP_K=4` |
| Gemini 모델 | `.env`의 `GEMINI_MODEL` |
| 임베딩 모델 / 차원 | `scripts/ingest.js` `outputDimensionality: 768` |
| 재시도 횟수 / 백오프 | `src/rag.js` 줄 117~156 (3회), `scripts/ocr.js` 242~286 (5회) |

### 외부 서비스 의존성 정리

| 서비스 | 용도 | 비용 |
|---|---|---|
| Google Gemini API | LLM + 임베딩 | 무료 한도 충분 (분당 15 req, 일 1,500 req) |
| Vercel | 서버리스 호스팅 | Hobby 무료 (개인용). 상업용은 Pro($20/월) |
| GitHub | 코드 + chunks.json | private repo 무료 |
| 카카오 i 오픈빌더 | 챗봇 플랫폼 | 무료 |
| 카카오톡 채널 | 사용자 진입점 | 무료 |

### 개선 로드맵

자세한 내용은 [IMPROVEMENTS.md](./IMPROVEMENTS.md) 참고.

- **P0** 플랫폼 마이그레이션 (Vercel → Fly.io), 보안(웹훅 인증, rate limit, 입력 방어)
- **P1** 스토리지 외부화 (Supabase pgvector), RAG 품질(reranker, hybrid search)
- **P2** 관측성 (Langfuse, 구조화 로그)

### 라이선스 / 권리

`source-files/` 자료(강의 PPT, 교안 등) 저작권은 원 저작자에게 있습니다. 내부 학습/안내용으로만 사용해야 하며, 외부 공개나 상업적 재배포는 원 저작자 동의가 필요합니다.

---

*KakaoClassBot — Gemini RAG · Vercel Serverless · 카카오 i 오픈빌더*
