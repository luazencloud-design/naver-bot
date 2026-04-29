# KakaoClassBot

PDF, PPTX, 한글, 영상, 음성, 자막 등 다양한 형식의 강의/안내 자료를 지식 베이스로 사용하는
**카카오톡 RAG 챗봇**입니다. 사용자가 카카오톡 채널에서 질문을 보내면, 등록된 자료에서
관련 내용을 검색해서 Gemini가 출처와 함께 답변합니다.

---

## 한눈에 보는 구조

```
[사용자]                   [카카오 i 오픈빌더]              [Vercel 서버리스]
   │                              │                              │
   ├─ 카카오톡에 질문 ─────────►   │                              │
   │                              ├─ 폴백 블록 → 스킬 호출 ──►    │
   │                              │                              ├─ src/rag.js
   │                              │                              │   ├─ Gemini로 질문 임베딩
   │                              │                              │   ├─ data/chunks.json에서
   │                              │                              │   │  코사인 유사도 검색
   │                              │                              │   └─ Gemini가 답변 생성
   │                              │   ◄──── 카카오 응답 포맷 ─────┤
   │   ◄──── 답변 + 출처 ──────────┤                              │
```

지식 베이스(`data/chunks.json`)는 로컬에서 한 번 만들고 GitHub에 commit하면,
Vercel이 자동 재배포해서 챗봇이 새 내용을 답변합니다.

---

## 사전 준비

| 항목 | 필요 여부 | 비고 |
|---|---|---|
| **Windows OS** | 필수 | PPTX → PDF 자동 변환이 PowerShell + PowerPoint COM 사용 |
| **Node.js 18+** | 필수 | https://nodejs.org 에서 LTS 버전 설치 |
| **Microsoft PowerPoint** | PPTX 사용 시 필수 | 자동 PDF 변환용 |
| **Git** | 권장 | clone/push용. 없으면 ZIP 다운로드도 가능 |
| **Gemini API key** | 필수 | https://aistudio.google.com/apikey 에서 발급 (무료) |
| **GitHub 액세스** | 권장 | `luazencloud-design/kakao-bot` collaborator 권한 필요 |

---

## 설치 및 첫 셋업

### 1. 코드 다운로드

```powershell
cd "C:\Users\<본인이름>\Desktop"
git clone https://github.com/luazencloud-design/kakao-bot.git
cd kakao-bot
```

Git이 없으면: GitHub repo 페이지에서 **Code → Download ZIP** → 압축 풀기.

### 2. 의존성 설치

`package.json`이 있는 폴더(`kakao-bot/`)에서:

```powershell
npm install
```

→ 약 1~2분 소요. `node_modules/` 폴더 자동 생성. (이 폴더는 GitHub에 안 올라감.
`package.json`을 보고 매번 새로 만드는 게 표준 방식.)

### 3. 환경변수 작성

```powershell
copy .env.example .env
notepad .env
```

다음 두 줄을 본인 값으로 수정:

```env
GEMINI_API_KEY=AIza...     # 본인이 발급받은 Gemini API key
```

나머지 값(`GEMINI_MODEL`, `EMBED_MODEL`, `TOP_K`)은 기본값 그대로 OK.
`SOURCE_FILE`은 비워두면 `source-files/` 폴더 전체를 자동 처리.

### 4. 소스 자료 배치

`source-files/` 폴더는 **GitHub에 올라가지 않습니다** (대용량 + 사적 정보 가능성).
전임자에게서 따로 받은 자료들을 `kakao-bot/source-files/`에 직접 복사하세요.

### 5. 첫 동작 확인

```powershell
node scripts/test-rag.js "사업자등록 절차"
```

지식 베이스에서 검색해 답변이 나오면 성공. 답변 끝에 `출처: <파일명>` 형식으로
어떤 자료에서 가져왔는지 표시됩니다.

---

## 일상 운영: 자료 추가/갱신

새 자료를 추가하거나 기존 자료를 수정한 경우:

```
1. source-files/ 폴더에 파일 드롭 (PDF, PPTX, TXT, HWP, VTT, MP3, MP4 등)
2. update.bat 더블클릭
3. 끝 — Vercel이 자동으로 ~60초 내 재배포
```

`update.bat`이 내부적으로 하는 일 (5단계):

```
[1/5] npm run ocr      Gemini OCR (스캔본/이미지/오디오/영상만)
                       PPTX → PDF 자동 변환 포함
                       이미 캐시된 파일은 자동 스킵 (캐시 stale도 자동 감지)
[2/5] npm run ingest   data/chunks.json 재생성 (모든 캐시된 텍스트를 청킹+임베딩)
[3/5] git add data/chunks.json
[4/5] git commit -m "Update knowledge base"
[5/5] git push         GitHub → Vercel 자동 재배포
```

---

## 지원하는 파일 형식

| 확장자 | 처리 방식 | Gemini API 호출 | 비용 | 추가 도구 필요 |
|---|---|---|---|---|
| **`.pdf`** | 텍스트 PDF: `pdf-parse`<br>스캔/이미지 PDF: Gemini Files API OCR | OCR 시 호출 | OCR 시 발생 | 없음 |
| **`.pptx`** | PowerPoint COM으로 자동 PDF 변환 → PDF 파이프라인 | 변환된 PDF에 OCR 시 호출 | OCR 시 발생 | **PowerPoint 필수** |
| **`.txt`** | `fs.readFileSync` 직접 읽기 | 안 함 | 무료 | 없음 |
| **`.hwp`** | `hwp.js` 라이브러리 로컬 파싱 | 안 함 | 무료 | HWP 5.x만 지원 |
| **`.vtt`** | 정규식 파서 (타임스탬프/화자 라벨 제거) | 안 함 | 무료 | 없음 |
| **`.mp3`** | Gemini Files API 음성 전사 | 호출 | 발생 | 없음 |
| **`.mp4`** | Gemini Files API 영상 전사 + 화면 텍스트 | 호출 | 발생 | 없음 |

### 형식별 권장 사용 시나리오

- **단순 본문 자료**: PDF, TXT, HWP — 추가 비용 없이 바로 처리
- **Zoom 강의 녹화**: `.vtt` 자막 파일 사용 권장 (Gemini 비용 0, 5시간 강의도 즉시)
- **이미지/스크린샷이 많은 PPT**: 자동 PDF 변환 → Gemini OCR
- **음성 강의**: MP3 직접 또는 사전에 Vrew/Whisper로 TXT 변환 후 투입
- **영상 강의**: 길면 VTT 자막 추출이 가장 효율적, 짧으면 MP4 직접

---

## 파일 구조

```
kakao-bot/
├── api/
│   └── index.js              # Vercel 서버리스 진입점 (Express app 래핑)
│
├── src/
│   ├── app.js                # Express 라우트 정의 (sync + callback 엔드포인트)
│   ├── server.js             # 로컬 개발용 .listen() (npm run dev)
│   ├── rag.js                # 임베딩 + 코사인 검색 + Gemini 답변 생성
│   └── kakao.js              # 카카오 응답 포맷 헬퍼
│
├── scripts/
│   ├── ocr.js                # source-files/ 순회 → 텍스트 추출 → data/extracted/ 캐시
│   ├── ingest.js             # 캐시된 텍스트 → 청킹 → 임베딩 → chunks.json
│   ├── test-rag.js           # 로컬 RAG 테스트 (서버 안 띄우고 답변 품질 확인)
│   └── lib/
│       ├── hwp-extract.js    # HWP 5.x 텍스트 추출
│       ├── vtt-extract.js    # WebVTT 자막 파서
│       ├── pptx-to-pdf.js    # PowerShell 호출 래퍼
│       └── pptx-to-pdf.ps1   # PowerPoint COM 자동화 스크립트
│
├── source-files/             # GitIgnored. 원본 자료 (PDF/PPTX/TXT 등) 저장
│   └── .gitkeep
│
├── data/
│   ├── chunks.json           # 임베딩된 지식 베이스 (Vercel이 런타임에 사용)
│   └── extracted/            # GitIgnored. OCR/추출 캐시 (재처리 방지)
│
├── .env                      # GitIgnored. API key 등 민감 정보
├── .env.example              # .env 작성 템플릿
├── .gitignore
├── .vercelignore             # Vercel 배포 시 제외할 파일 (scripts/, .env 등)
├── package.json              # 의존성 목록 + npm 스크립트
├── package-lock.json         # 버전 고정
├── vercel.json               # Vercel 라우팅 + 함수 설정 (chunks.json 포함)
├── update.bat                # 원클릭 워크플로 (OCR + ingest + push)
└── README.md                 # 이 문서
```

### 핵심 데이터 흐름

```
source-files/<파일>          (사용자가 드롭하는 원본)
        │
        ▼  npm run ocr (또는 update.bat)
data/extracted/<stem>.txt    (텍스트 캐시. 한 번 추출하면 재사용)
        │
        ▼  npm run ingest (또는 update.bat)
data/chunks.json             (청킹 + 임베딩된 지식 베이스. Vercel이 사용)
        │
        ▼  git push
GitHub → Vercel 재배포       (~60초 내 카카오 봇이 새 내용 반영)
```

---

## 환경변수 (.env)

| 이름 | 필수? | 기본값 | 설명 |
|---|---|---|---|
| `GEMINI_API_KEY` | 필수 | - | https://aistudio.google.com/apikey 에서 발급 |
| `GEMINI_MODEL` | 선택 | `gemini-flash-lite-latest` | 답변 생성용 모델. 빠르고 503 적게 남 |
| `EMBED_MODEL` | 선택 | `gemini-embedding-001` | 768차원 임베딩, 한국어 지원 |
| `TOP_K` | 선택 | `4` | 질문당 검색할 상위 청크 수 |
| `PORT` | 선택 | `3000` | 로컬 dev 서버 포트 |
| `SOURCE_FILE` | 선택 | (없음) | 설정 시 그 파일만 처리. 비우면 `source-files/` 전체 |

> Vercel 배포에서는 같은 환경변수를 **Vercel 대시보드 → Settings → Environment Variables**에서
> 별도로 설정해야 합니다. 로컬 `.env`는 Vercel과 무관합니다.

---

## npm 스크립트

| 명령 | 설명 |
|---|---|
| `npm run ocr` | `source-files/`의 모든 파일을 처리해 `data/extracted/`에 캐싱. 캐시된 파일은 자동 스킵 |
| `npm run ocr -- --force` | 캐시 무시하고 전부 재처리 (Gemini 비용 발생) |
| `npm run ingest` | `data/extracted/`의 모든 텍스트를 청킹+임베딩해서 `data/chunks.json` 생성 |
| `npm start` | 로컬 dev 서버 (포트 3000) 띄워서 `/kakao/skill` 직접 호출 가능 |
| `npm run dev` | 위와 동일하지만 파일 변경 시 자동 재시작 (`node --watch`) |

추가 유용한 직접 실행:
```powershell
node scripts/test-rag.js "원하는 질문"
```
서버 안 띄우고 RAG 파이프라인만 빠르게 테스트.

---

## 트러블슈팅

### "정보가 포함되어있지 않습니다" 답변이 자주 나옴
- `data/chunks.json`이 비어있거나 stale일 가능성
- `npm run ingest`로 재생성, 안 되면 `npm run ocr -- --force` 후 재시도

### Gemini 503 "high demand" 에러
- 일시적 과부하. 자동 재시도가 코드에 포함되어 있어 보통 해결됨
- 계속되면 `GEMINI_MODEL`을 `gemini-2.5-flash` 또는 `gemini-2.5-pro`로 변경 시도

### PPTX 파일이 처리 안 됨
- PowerPoint가 설치되어 있는지 확인
- 그 파일이 다른 곳(PowerPoint 등)에서 열려 있지 않은지 확인 (`~$파일명.pptx` lock 파일 있으면 PowerPoint가 잡고 있는 것)
- 안 되면 PowerPoint에서 수동으로 PDF 저장 후 `source-files/`에 PDF 직접 배치

### 카카오 봇이 응답 안 함 / "스킬 실행 오류"
- Vercel **Deployments** 탭에서 최근 배포가 성공했는지 확인
- Vercel **Logs** 탭에서 실제 에러 확인
- `https://naver-bot-one.vercel.app/` 직접 접속해서 `{"status":"ok",...}` 보이는지

### 파일을 수정했는데 답변이 옛날 내용
- 캐시 stale 자동 감지 로직이 있어서 보통 자동 갱신됨
- 안 되면 `data/extracted/<해당파일>.txt` 삭제 후 `update.bat` 재실행

---

## 인수인계 시 체크리스트

- [ ] GitHub repo collaborator 권한 받음
- [ ] Vercel 프로젝트 멤버로 추가됨
- [ ] 카카오 i 오픈빌더 운영자로 추가됨
- [ ] 카카오톡 채널 매니저로 추가됨
- [ ] 본인 Gemini API key 발급 (https://aistudio.google.com/apikey)
- [ ] Vercel 환경변수 `GEMINI_API_KEY` 본인 키로 교체 + Redeploy
- [ ] `source-files/` 자료 별도 전달받음 (USB/클라우드 드라이브)
- [ ] 로컬에서 `npm install` + `node scripts/test-rag.js`로 동작 확인
- [ ] `update.bat` 1회 실행해 전체 파이프라인 검증
- [ ] 카카오 봇 테스트 패널에서 실제 질의응답 확인

---

## 외부 서비스 의존성

| 서비스 | 용도 | 비용 |
|---|---|---|
| Google Gemini API | LLM + 임베딩 | 무료 한도 충분 (분당 15 req, 일 1,500 req). 초과 시 사용량 기반 과금 |
| Vercel | 서버리스 호스팅 | Hobby 플랜 무료 (개인용). 상업용은 Pro($20/월) 필요 |
| GitHub | 코드 + chunks.json 저장 | private repo 무료 |
| 카카오 i 오픈빌더 | 챗봇 플랫폼 | 무료 |
| 카카오톡 채널 | 사용자 진입점 | 무료 |

---

## 라이선스 / 권리

`source-files/` 안의 자료(강의 PPT, 교안 등) 저작권은 원 저작자에게 있습니다.
이 챗봇은 내부 학습/안내용으로 사용해야 하며, 외부 공개나 상업적 재배포는
원 저작자 동의가 필요합니다.
