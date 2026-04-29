# kakao-class-bot 개선안 (실운영 기준)

현재 `main` 브랜치 기준 분석. **실사용 서비스** 전제로 아키텍처 · 품질 · 운영 세 축 정리.
취미 프로토타입 수준 권고는 배제하고, SLA · 백업 · 장애 대응 · 비용 예측 관점까지 포함.

---

## 현재 상태 진단

- 49청크 / 768차원 Gemini 임베딩 / `data/chunks.json` 단일 파일
- Vercel 서버리스 배포 (`api/index.js` + `vercel.json`)
- Naive RAG (dense retrieval only, reranker 없음)
- 세션/관측성/인증 없음
- 콜백 모드는 `res.json()` 뒤 background Promise — Vercel에서 suspend 위험

**구조적 병목 3가지:**
1. 지식베이스가 함수 번들 안에 있음 (Lambda 원칙 위반, 50MB 한계)
2. 백그라운드 작업을 함수 lifetime에 의존
3. 벤더(Gemini) 락인 + 단일 장애점

---

## P0 — 플랫폼 마이그레이션 (가장 먼저)

### 문제
Vercel/Lambda는 이 앱에 부적합:
- 콜백 모드 [app.js:68](src/app.js:68) 백그라운드 Promise → 함수 suspend 시 유실 (**실운영에선 간헐적 답변 유실 = 신뢰도 직결**)
- 번들 50MB 제한 → 강의 영상 인덱싱 시 배포 실패
- 콜드스타트마다 `chunks.json` 재파싱 → 첫 응답 5초 초과로 카카오 timeout
- `waitUntil`은 Pro 유료

### 해결: Fly.io (실운영 구성)

**코드 변경: 0줄.** [src/server.js](src/server.js)가 이미 Express 진입점으로 존재. [api/index.js](api/index.js)는 같은 `app.js`를 서버리스용으로 래핑한 것뿐.

**실운영 구성 (취미용 아님):**
- `shared-cpu-2x` + **1GB RAM** ($5~7/월) — 256MB 무료는 Gemini 클라이언트 + 동시 요청 여러 개 감당 안 됨
- **Tokyo(`nrt`) + Seoul(`icn`) 2개 리전** — 리전 장애 격리
- **min_machines_running = 2** — 롤링 배포·리전 장애 중 무중단
- **Health check** + **auto-restart** 활성화
- **Volume** 연결해 로그·캐시 영구 보존

**추가 파일:**

`Dockerfile`
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["npm", "start"]
```

`fly.toml`
```toml
app = "kakao-class-bot"
primary_region = "nrt"   # Tokyo — 한국 latency 최소

[build]

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = false
  min_machines_running = 2     # 무중단 배포·리전 장애 격리
  concurrency = { type = "requests", soft_limit = 50, hard_limit = 100 }

[[http_service.checks]]
  interval = "15s"
  timeout = "5s"
  method = "GET"
  path = "/"

[[vm]]
  size = "shared-cpu-2x"
  memory = "1gb"

[env]
  PORT = "3000"
  NODE_ENV = "production"
```

**삭제:**
- `api/index.js`
- `vercel.json`
- `.vercelignore`

**배포:**
```bash
fly launch
fly secrets set GEMINI_API_KEY=AIzaXXX
fly deploy
```

**카카오 오픈빌더 웹훅 URL만 변경:**
`https://kakao-class-bot.fly.dev/kakao/skill`

### 덤으로 해결되는 것
- 콜백 모드 백그라운드 Promise 안전하게 동작
- 콜드스타트 제거 (부팅 시 JSON 1회만 로드, 이후 메모리 상주)
- Tokyo 리전으로 카카오 응답 latency 개선

### 대안 (실운영 관점)

| 플랫폼 | 예상 월 비용 | 한국 latency | 실운영 적합도 |
|---|---|---|---|
| **Fly.io** (shared-cpu-2x 2대) | ~$10~14 | 🟢 Tokyo | ⭐⭐⭐⭐⭐ 권장 |
| **AWS ECS Fargate** (Seoul) | ~$25~40 | 🟢 Seoul | ⭐⭐⭐⭐⭐ 엔터프라이즈 |
| **Naver Cloud (NCP) Container Registry** | ~$20~35 | 🟢 Seoul | ⭐⭐⭐⭐ 국내 데이터 보관 이슈 있을 때 |
| **Google Cloud Run** (Seoul) | ~$10~20 | 🟢 Seoul | ⭐⭐⭐⭐ stateless면 최적 |
| **Railway** | ~$5~20 | 🔴 US/EU | ⭐⭐⭐ 한국 latency 불리 |
| **Render** | ~$7~25 | 🟡 Singapore | ⭐⭐⭐ Sleep 없는 유료 티어 필수 |

**의사결정 기준:**
- 데이터 주권 이슈 있음 (수강생 개인정보 국내 보관) → **NCP / AWS Seoul**
- 비용 최적화 + 충분한 성능 → **Fly.io Tokyo** (가장 추천)
- 기존 AWS 생태계 사용 중 → **ECS Fargate + ALB**
- 트래픽 버스트 큰 이벤트 운영 → **Cloud Run** (요청당 과금)

---

## P0 — 보안 (실운영 필수)

### 1. 웹훅 인증
현재 `/kakao/skill`은 완전 공개. 누구나 POST 가능 → Gemini 비용 소진 공격 + 가짜 응답 주입.

**해결 (다층 방어):**
- **시크릿 경로**: `/kakao/skill/<랜덤 32자>` — URL 자체가 비밀
- **IP 화이트리스트**: 카카오 i 오픈빌더 발신 IP 대역만 허용
- `X-Kakao-Signature` 같은 헤더 검증 (오픈빌더 문서 확인 필요)
- **장애 대응 시크릿 로테이션 절차 문서화**

### 2. Rate limit (사용자별 + 글로벌)
```js
import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';  // 다중 인스턴스면 Redis 백엔드 필수

app.use('/kakao', rateLimit({
  windowMs: 60_000,
  max: 20,   // 사용자당 분당 20회
  keyGenerator: (req) => req.body?.userRequest?.user?.id ?? req.ip,
  store: new RedisStore({ sendCommand: (...args) => redis.sendCommand(args) }),
}));
```
**글로벌 한도도 별도로 설정** — Gemini 월 예산 상한 초과 시 자동 차단.

### 3. 입력 방어
- utterance 길이 제한 (500자)
- 프롬프트 인젝션 방어: system prompt에서 사용자 입력 구간 명확히 분리 (`<user_query>...</user_query>`)
- 의심 패턴(`ignore previous instructions`, `system:` 등) 필터

### 4. 비용 상한
- Gemini API 월 예산 알람 (Google Cloud Billing 알림)
- 일일 호출 수 카운터 → 임계치 초과 시 자동 차단 + 관리자 알림
- 단일 사용자 abuse 감지 (비정상 패턴 요청 수 → 일시 차단)

### 5. 비밀값 관리
- 절대 Git에 커밋 금지 (.env.example만)
- Fly Secrets / AWS Secrets Manager / GCP Secret Manager
- 분기별 API 키 로테이션 정책

### 6. PII / 로그
- 질문에 개인정보 포함 가능성 고려 (사업자등록번호, 연락처 등)
- 로그 수집 시 PII 마스킹 (`***-**-****` 패턴)
- 법적 요건 확인: 개인정보보호법 수집·이용 동의 흐름이 카카오 채널 쪽에서 이뤄지는지 확인

---

## P1 — 스토리지 외부화

### 문제
`data/chunks.json`이 배포 번들 안 → 갱신 시 재배포, 50MB 한계, 콜드스타트 비용.

### 해결: Supabase pgvector

**테이블:**
```sql
create extension if not exists vector;

create table chunks (
  id bigserial primary key,
  source text not null,
  text text not null,
  embedding vector(768) not null,
  metadata jsonb default '{}'::jsonb
);

create index on chunks using hnsw (embedding vector_cosine_ops);
create index on chunks (source);
```

**검색 RPC:**
```sql
create or replace function match_chunks(
  query_embedding vector(768),
  match_count int default 4
)
returns table (id bigint, source text, text text, score float)
language sql stable as $$
  select id, source, text, 1 - (embedding <=> query_embedding) as score
  from chunks
  order by embedding <=> query_embedding
  limit match_count;
$$;
```

**[src/rag.js](src/rag.js) 변경 지점 (약 30줄):**
```js
// Before: knowledge = JSON.parse(fs.readFileSync(CHUNKS_PATH))
// After:
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function searchTopK(queryEmbed, k = TOP_K) {
  const { data, error } = await supabase.rpc('match_chunks', {
    query_embedding: queryEmbed,
    match_count: k,
  });
  if (error) throw error;
  return data;
}
```

**[scripts/ingest.js](scripts/ingest.js) 변경 지점:** 마지막 `fs.writeFileSync(CHUNKS_PATH, ...)` → `supabase.from('chunks').insert(...)` (upsert 가능).

### 이점
- Upsert로 강의 추가 시 부분 갱신 (전체 재ingest 불필요)
- 필터링 가능 (`where source = '3주차.mp4'`)
- HNSW 인덱스 → O(log N) 검색
- 번들에서 `chunks.json` 제거

### 실운영 고려사항
- **무료 티어 500MB는 운영 시작 후 6개월~1년 수준** — 유료 티어 ($25/월 Pro) 전환 계획 수립
- **자동 백업 활성화** (Supabase Pro는 PITR 제공, 무료는 daily)
- **`service_role` 키는 서버 측에서만** 사용, 절대 클라이언트 노출 금지
- **인덱스 파라미터 튜닝**: HNSW의 `m`, `ef_construction` 기본값은 소규모용. 수만 청크 넘으면 재튜닝
- **재해 복구**: 매일 `chunks` 테이블 덤프를 S3에 별도 백업 (Supabase 전체 장애 대비)
- **소스 원본(source-files/) 별도 보관**: 재ingest 가능하도록 S3/Vercel Blob 등에 영구 저장 — 로컬 디스크만 있으면 유실 시 복구 불가

---

## P1 — RAG 품질 개선

현재 Naive RAG (단일 dense retrieval). Advanced RAG으로 업그레이드.

### 1. Query rewriting
원문 질문 그대로 임베딩하면 동의어/오탈자에 약함.

**[src/rag.js](src/rag.js) `answerQuestion` 앞단에 추가:**
```js
async function rewriteQuery(original) {
  // Gemini Flash Lite로 검색용 쿼리 1회 생성
  // 예: "재발급 어떻게?" → "사업자등록증 재발급 재교부 신청 방법"
}
```
비용: 쿼리당 Flash Lite 1회 추가 호출 (<200ms, 거의 무료).

### 2. 하이브리드 검색 (Dense + BM25)
Postgres `tsvector` + 기존 dense 검색 결과를 **RRF**로 결합.

```sql
-- chunks 테이블에 tsvector 컬럼 추가
alter table chunks add column tsv tsvector
  generated always as (to_tsvector('simple', text)) stored;
create index on chunks using gin (tsv);
```

```sql
create or replace function hybrid_search(
  query_embedding vector(768),
  query_text text,
  match_count int default 20
) returns table(...) ...
-- dense top-N + bm25 top-N → RRF 융합
```

### 3. Reranker
top-20 뽑아서 **Cohere Rerank API** 또는 **bge-reranker**로 재정렬 → top-4.

```js
import { CohereClient } from 'cohere-ai';
const cohere = new CohereClient({ token: process.env.COHERE_API_KEY });

const reranked = await cohere.rerank({
  model: 'rerank-multilingual-v3.0',
  query,
  documents: top20.map(c => c.text),
  topN: 4,
});
```
Cohere 무료 티어: 월 1,000 호출. 효과는 가장 큼.

### 4. 청킹 개선
현재 [ingest.js:117](scripts/ingest.js:117) 문단 기반 800자 고정.

- **헤더/섹션 인식**: PDF는 `pdf-parse`에서 폰트 크기로 h1/h2 추정, PPTX는 슬라이드 단위 청크
- **표·리스트 원형 보존**: 표는 분할 금지
- **타임스탬프 보존 (영상)**: 전사에 `[00:12:34]` 넣어서 citation에 "3주차 12:34 참고" 표시
- **메타데이터 추가**: `{ week: 3, topic: "사업자등록", start_ts: "00:12:34" }`

### 5. Grounding 검증
생성된 답변의 각 문장이 retrieved context의 어떤 span을 근거로 하는지 검증. 미근거 문장은 제거하거나 "자료 없음" 처리.

---

## P2 — 관측성 & 피드백

### Langfuse 연동
오픈소스, self-host 가능. 무료 티어도 있음.

기록할 항목:
- 모든 질문, retrieved chunks, 답변, latency
- Gemini 토큰 사용량
- "자료에 없음" 응답 집계 → 지식베이스 gap 분석
- 👍/👎 사용자 피드백 (카카오 답변 말미에 버튼)

### 로깅 레벨 정리
현재 `console.log` 일색. 구조화 로그로 전환:
```js
import pino from 'pino';
const logger = pino();
logger.info({ userId, question, latency }, 'sync_request');
```

### 핵심 지표
- **Retrieval hit rate**: top-K 안에 정답 청크가 있는 비율
- **Faithfulness**: 답변이 context에 근거한 비율
- **Answer relevance**: 답변이 질문에 맞는 정도
- **Ragas** 같은 프레임워크로 자동 측정

---

## P2 — 대화 세션

현재 멀티턴 불가. "그럼 그건 얼마야?" 같은 후속 질문 맥락 유지 못함.

### 해결: Upstash Redis (무료 티어)

```js
import { Redis } from '@upstash/redis';
const redis = Redis.fromEnv();

const userId = req.body?.userRequest?.user?.id;
const history = await redis.lrange(`session:${userId}`, 0, 5);

// ... RAG 처리 ...

await redis.lpush(`session:${userId}`, JSON.stringify({ q, a }));
await redis.expire(`session:${userId}`, 1800);  // 30분 TTL
```

후속 질문 감지 시 history를 query rewriting 입력으로 포함.

---

## P1 — Fallback 체인 (실운영 필수, P2 → P1로 승격)

실운영에선 벤더 장애 = 서비스 장애. Gemini 5xx/rate limit 시 이중화 필요.

### 생성 모델 다중화
```js
async function generateWithFallback(prompt, question) {
  const providers = [
    () => generateWithGemini(prompt, question),    // 1순위
    () => generateWithClaude(prompt, question),    // Haiku 4.5 — 속도·가격 비슷
    () => generateWithOpenAI(prompt, question),    // GPT-4o-mini — 최후
  ];
  for (const [i, fn] of providers.entries()) {
    try { return await fn(); }
    catch (e) {
      logger.warn({ provider: i, err: e.message }, 'llm_fallback');
      if (i === providers.length - 1) throw e;
    }
  }
}
```

### 임베딩 전략
- **질문 임베딩 LRU 캐시** (Redis) — 자주 묻는 질문은 캐시 히트
- 임베딩 벤더 대체는 **어려움** — 차원·분포 다르면 DB 재구축 필요
- **보조책**: Gemini 임베딩 장애 시 BM25 단독 검색으로 graceful degradation

### 모니터링
- 각 벤더별 성공률·latency·비용 대시보드
- 주 벤더 장애 감지 시 자동 알림 (PagerDuty/Slack)

---

## P1 — 실운영 필수 사항 (추가)

### CI/CD
- **GitHub Actions**: PR 시 린트·테스트·타입체크, main 머지 시 자동 배포
- **스테이징 환경** 필수 — 프로덕션 카카오 봇과 분리된 테스트 채널로 먼저 검증
- **헬스체크 실패 시 자동 롤백** (Fly.io는 기본 지원)

### 테스트
- RAG 응답 smoke test (핵심 질문 30개에 대해 "자료 없음" 외 응답 반환)
- 웹훅 스펙 호환 테스트 (카카오 예시 payload로 schema 검증)
- 로컬 이식 가능한 통합 테스트 ([scripts/test-rag.js](scripts/test-rag.js) 이미 있음 — 확장)

### 장애 대응 절차 (Runbook)
- Gemini 503 지속 → 다른 프로바이더 강제 전환 토글
- Supabase 다운 → 캐시된 `chunks.json` 읽기전용 fallback
- 배포 후 에러율 급증 → 원클릭 롤백 명령
- 대응 매뉴얼을 `RUNBOOK.md`로 레포에 보관

### SLA 목표 (참고)
- **가용성 99.5%** (월 3.6시간 허용) — 개인 운영이면 현실적 목표
- **p95 응답시간 3초** (카카오 5초 마진 확보)
- **답변 만족도 (👍 비율) 80%+** — 사용자 피드백으로 측정

### 비용 모델링 (실트래픽 기준)
| 트래픽 | 월 예상 비용 |
|---|---|
| DAU 50, 1인당 10회 질문 | Gemini $5~10 + Fly $10 + Supabase 무료 = **~$20** |
| DAU 500 | Gemini $50~100 + Fly $15 + Supabase $25 = **~$150** |
| DAU 5,000 | Gemini $500~1,000 + Fly $50 + Supabase $25 + 관측성 $30 = **~$1,100** |

**트래픽 늘면 Gemini가 압도적 비용 비중** → 캐싱·프롬프트 압축·Haiku 등 저렴 모델 비율 조정으로 절감.

---

## P3 — 장기 과제

### 임베딩 버전 태깅
`chunks` 테이블에 `embed_model`, `dim` 컬럼 추가 → 모델 교체 시 구/신 병렬 검색으로 점진 마이그레이션.

### 평가 세트 + CI
예상 Q&A 30~50쌍 수동 작성 → CI에서 Ragas로 faithfulness/relevance 자동 측정. 개선안 효과 수치로 검증.

### 권한/카테고리 필터
`source` 외에 `category`, `visibility` 메타데이터 → 질문 유형이나 사용자 권한별 필터링.

### 영상 특화 파이프라인
- **슬라이드 + 전사 결합**: 화면 OCR + 음성 전사를 시간축으로 정렬
- **필러 제거**: 전사 원문의 "어", "그래서 이제" 같은 filler를 LLM으로 정제 후 임베딩
- **섹션 분절**: 강의 내용 전환점 자동 감지해 청크 경계로 사용

---

## 우선순위 로드맵 (실운영 오픈 기준)

### Week 1 — 기반 이관 & 보안
- [ ] **스테이징 환경** Fly.io 구성 (prod와 분리된 앱/도메인)
- [ ] Dockerfile + fly.toml 작성, `fly deploy`
- [ ] Supabase 프로젝트 + pgvector 테이블 + `match_chunks` RPC
- [ ] [ingest.js](scripts/ingest.js) / [rag.js](src/rag.js) Supabase 연동
- [ ] **웹훅 시크릿 경로 + IP 화이트리스트 + rate limit**
- [ ] 입력 길이 제한, 프롬프트 인젝션 가드
- [ ] Gemini 월 예산 알람 설정

### Week 2 — 관측성 & 품질
- [ ] Langfuse 연동 (질문·retrieval·답변·latency 모두 기록)
- [ ] 구조화 로그 (pino) + 에러 추적 (Sentry)
- [ ] Cohere Rerank 도입
- [ ] Query rewriting
- [ ] 스모크 테스트 세트 30개 구축

### Week 3 — 이중화 & 안정성
- [ ] LLM 벤더 fallback 체인 (Gemini → Claude Haiku → GPT-4o-mini)
- [ ] Upstash Redis 세션 (멀티턴 지원)
- [ ] Supabase 자동 백업 + S3 이중 백업
- [ ] 헬스체크 + 자동 롤백
- [ ] RUNBOOK.md 작성

### Week 4 — 프로덕션 오픈 준비
- [ ] 부하 테스트 (k6 또는 Artillery)
- [ ] 카카오 심사 제출
- [ ] 사용자 피드백 버튼 (👍/👎) 구현
- [ ] 대시보드 구성 (Langfuse + Grafana)
- [ ] 비용 대시보드 + 임계 알람

### Month 2+ — 고도화
- [ ] 하이브리드 검색 (BM25 + RRF)
- [ ] 청킹 로직 개선 (헤더 인식 + 영상 타임스탬프)
- [ ] 평가 세트 + CI 자동 측정 (Ragas)
- [ ] 필러 제거 파이프라인 (영상 전사 정제)
- [ ] 피드백 기반 지식베이스 gap 보완 루프

---

## 가장 ROI 높은 3가지 (실운영 오픈 직전에 최소 필수)

1. **플랫폼 이관 + 스토리지 외부화** — Fly.io + Supabase pgvector. 콜백 suspend·번들 한계·콜드스타트 동시 해소. 이 없이 운영 불가.
2. **보안 3종 세트** — 웹훅 인증 + rate limit + 예산 상한. 공개 웹훅은 **실운영 시 최우선 리스크**.
3. **LLM fallback + 관측성** — Gemini 단일 의존 + `console.log`만 있는 상태로 운영 시작하면 장애 시 무력함. Langfuse + 3중 벤더로 최소 대응력 확보.

위 3개는 **옵션이 아니라 실운영 오픈 전 필수**. 나머지는 오픈 후 증분 개선 가능.

---

## 최소 운영 인원 가정

- **1인 운영**: 자동화·알람·롤백·모니터링이 **반드시** 잘 되어 있어야 함 (새벽 장애 대응 불가)
- **2~3인 팀**: 교대 오콜 가능, 수동 대응 여지 있음
- **카카오 채널 규모가 클 것으로 예상된다면** 운영 인력·예산 사전 확보 필수

---

## 오픈 전 체크리스트 (Go/No-Go)

- [ ] 스테이징에서 7일간 무장애 운영 확인
- [ ] 부하 테스트: 예상 피크 트래픽 × 3배 통과
- [ ] 장애 주입 테스트: Gemini 죽여도 Claude로 fallback, Supabase 죽여도 일부 응답 가능
- [ ] 롤백 시나리오 연습 1회 이상
- [ ] Runbook에 따른 관리자 대응 시뮬레이션
- [ ] 보안 점검: OWASP top 10, 프롬프트 인젝션 케이스 50개
- [ ] 개인정보 처리방침 · 이용약관 준비 (법무 검토)
- [ ] 카카오 검수 통과
