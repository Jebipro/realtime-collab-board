# 실시간 동기화 adversarial review

대상: realtime-collab-board repository

검토일: 2026-10-06 (Asia/Seoul)

**원본 판정: FAIL — 아래 9개 결함군 발견. 확인한 결함은 최소 수정으로 고쳤고, 수정 후 tests / typecheck / build가 모두 통과했다.**

기능 추가, 리팩터링, UI 디자인 변경은 하지 않았다. 컴포넌트 변경은 서버가 거부한 텍스트 draft를 기존 편집기에 복원하고, 로컬 저장 실패 시 편집기를 닫지 않는 처리뿐이다. 수정 사항과 회귀 테스트는 `fix: harden realtime synchronization` 커밋에 포함되어 있다.

## 발견 사항과 재현 절차

P1은 서버 종료·상태 손상·작성 내용 손실을 일으키는 결함, P2는 특정 재연결/메시지 경합에서의 일관성 또는 복구 결함으로 분류했다. 위치는 수정 후 소스 기준이다.

### 1. P1 — malformed WebSocket frame이 서버 프로세스를 종료시킴

- 위치: `server/app.ts:54`
- 재현: `/ws`에 연결한 뒤 16,385바이트 프레임, 또는 UTF-8 텍스트 프레임에 `0xff`를 전송한다.
- 원인: `ws`의 payload/UTF-8 검증은 `error` 이벤트를 발생시키는데 연결에 error listener가 없다. 테스트에서 `WS_ERR_UNSUPPORTED_MESSAGE_LENGTH`, `WS_ERR_INVALID_UTF8` 미처리 예외를 모두 확인했다. 일반 JSON 파싱 실패 테스트는 이 경로를 검증하지 않았다.
- 수정: 오류가 난 소켓을 종료하는 listener를 설치했다.
- 회귀: `test/ws.integration.test.ts`의 oversized / invalid UTF-8 2개 사례. 문제 연결 종료 후 새 클라이언트가 카드 생성과 revision 증가에 성공하는지 검증한다.

### 2. P1 — 2,000개 dedupe 기록 만료 후 재전송이 삭제된 카드를 부활시킴

- 위치: `server/room.ts:28`, `server/room.ts:81`
- 재현: A의 create가 서버에 적용되지만 ack를 받지 못한다 → 카드를 삭제한다 → 다른 카드에 2,001개 move를 적용한다 → A가 reconnect하여 원래 create를 재전송한다.
- 원본 결과: room revision이 2,004에서 2,005로 증가하고 삭제된 카드가 다시 생긴다. move도 기록 만료 후 다시 적용되어 더 최신 위치를 덮어쓸 수 있다.
- 수정: room 수명 동안 opId별 처리 결과를 유지한다. 시간이나 개수만으로 이미 적용한 operation의 기록을 제거하지 않는다.
- 회귀: `test/adversarial.test.ts`의 `does not resurrect an ack-lost create after deletion and 2000 later ops`.

### 3. P1 — prototype 이름을 카드 ID로 사용하면 서버 상태가 손상됨

- 위치: `shared/board.ts:33`, `shared/board.ts:39`, `shared/board.ts:49`, `shared/board.ts:54`
- 재현: 빈 room에 `{ kind: "card.move", opId: "evil", cardId: "constructor", x: 1, y: 1 }`을 보낸다. `__proto__`, `toString`도 같은 경로를 탄다.
- 원인: 프로토콜은 이 ID들을 허용하지만 `cards[id]` 존재 검사는 상속된 Object 속성을 실제 카드로 취급한다. move가 승인되고 ID/필수 필드가 없는 객체가 상태에 들어가며 revision이 증가한다. `cardsFromList`의 `__proto__` 대입도 일반 카드 삽입처럼 동작하지 않는다.
- 수정: 존재 검사를 `Object.hasOwn`으로 바꾸고 snapshot 목록은 `Object.fromEntries`로 변환했다. 허용된 ID 자체를 금지하는 대신 일반 카드 ID로 안전하게 처리한다.
- 회귀: `test/adversarial.test.ts`의 세 특수 ID에 대한 nonexistent move 거부, create 및 snapshot 왕복 검증.

### 4. P1 — 실제 서버 stale reject 후 제출한 draft가 사라짐

- 위치: `src/sync/syncState.ts:140`, `src/components/CardView.tsx:49`, `src/components/BoardView.tsx:122`
- 재현: A/B가 textVersion 0을 편집한다 → B가 먼저 저장한다 → B의 broadcast가 A에 도착하기 전에 A도 저장한다 → A가 B의 op와 자신의 `reject(stale)`를 받는다.
- 원인: 기존 UI는 이미 관측한 충돌에서는 draft를 보존하지만, 전송 직후에는 편집기를 닫는다. 이후 reject가 pending을 삭제하면 제출 텍스트도 사라진다.
- 수정: 거부된 text operation과 원래 baseTextVersion을 별도로 보존하고 기존 편집기에 복원한다. 새 편집 제출 시 해당 복구 항목을 지운다. `submit`이 로컬에서 실패한 경우에도 편집기를 유지한다.
- 회귀: `test/adversarial.test.ts`의 rejected text 보존 및 후속 제출 시 해제 검증.
- 실제 브라우저 확인: 같은 origin의 headless Edge 두 탭에서 A 수신을 지연시킨 상태로 B 저장 → A 저장 → op/reject 전달 순서를 만들었다. rollback 후 confirmed는 B의 텍스트, pending은 0, textarea는 A의 원래 draft인 것을 확인했다.

### 5. P2 — 중복 op 응답이 원래 결과가 아니며, 거부된 operation의 결과도 바뀜

- 위치: `server/room.ts:81`, `server/room.ts:95`, `src/sync/syncState.ts:114`
- 재현 A: create를 승인받은 뒤 같은 opId에 move payload를 넣어 보낸다. 원본은 예전 revision에 새 payload를 붙여 ack한다. create 재시도에서는 서버가 확정한 authorName 대신 요청의 authorName을 돌려준다.
- 재현 B: 다른 client가 같은 opId로 다른 작업을 제출한다. 원본은 실행하지 않은 작업을 성공한 것처럼 응답한다. 수신 측도 `by` 확인 없이 같은 opId의 로컬 pending을 지운다.
- 재현 C: 없는 카드에 move → `not_found` → 해당 ID 카드 생성 → 동일 move 재전송. 원본은 거부했던 operation을 이제 승인한다.
- 수정: 소유 clientId와 정규화된 최초 ack/reject를 기록한다. 동일 소유자의 재전송은 최초 결과를 반환하고, 다른 소유자의 충돌은 invalid로 거부한다. 클라이언트도 ack의 `by === selfId`를 확인한다.
- 회귀: `test/adversarial.test.ts`의 canonical ack, opId collision, terminal rejection, 다른 author의 ack 사례.

### 6. P2 — snapshot 위에서 이미 적용된 pending을 다시 optimistic replay함

- 위치: `src/sync/syncState.ts:18`, `src/sync/syncState.ts:94`
- 재현 A: ack를 잃은 create의 카드가 다른 사용자에게 삭제된 뒤 reconnect한다. snapshot에는 없지만 pending create가 replay되어 화면에서 카드가 잠시 부활한다.
- 재현 B: ack를 잃은 move 이후 다른 사용자가 더 최신 위치로 이동한다. reconnect snapshot의 최신 위치를 오래된 pending move가 덮어쓴다. 중복 ack가 도착할 때까지 실제 서버 상태와 다른 위치가 보인다.
- 수정: 현재 소켓의 `sent`와 별도로 과거 전송 시도를 기억한다. snapshot 수신 후 적용 여부가 불명확한 기존 전송 op는 결과를 받을 때까지 optimistic replay에서 제외하되, pending에 유지하여 재전송한다. 오프라인 중 한 번도 보내지 않은 op는 계속 replay한다.
- 회귀: `test/adversarial.test.ts`의 삭제 카드 재등장 및 최신 위치 덮어쓰기 사례. `test/BoardClient.test.ts`에서 ack 유실과 오프라인 create/edit/move를 함께 재전송한 후 pending 0, confirmed/view/server 일치를 검증한다.

### 7. P2 — 소켓 교체 경합에서 옛 연결의 메시지가 상태를 바꾸거나 pending이 정체됨

- 위치: `src/sync/BoardClient.ts:149`, `server/room.ts:69`, `server/room.ts:75`
- 재현 A: 이전 소켓 close 이벤트 전에 수동 retry로 새 연결을 만들고 이전 연결의 지연된 open/snapshot/presence 이벤트를 전달한다. 원본은 새 연결로 join을 보내거나 최신 상태를 오래된 데이터로 교체할 수 있다.
- 재현 B: 전송 중인 op가 있는 상태에서 이전 close 전에 retry한다. 원본은 `sent=true`를 유지하므로 새 welcome 이후 그 op를 재전송하지 않는다.
- 재현 C: 같은 clientId의 연결이 교체된 직후 옛 연결이 op/sync를 보내면 원본 서버는 현재 member의 요청처럼 처리한다. leave만 소켓 소유권을 검사하고 있었다.
- 수정: 연결 교체 전에 이전 세대를 무효화하고 닫으며 pending 전송 플래그를 초기화한다. open/message/timeout도 현재 소켓인지 검사한다. 서버는 op/sync에도 현재 send 소유권을 확인한다.
- 회귀: `test/BoardClient.test.ts`의 late callbacks/manual retry, `test/adversarial.test.ts`의 replaced connection 및 author/presence 보존 검증.

### 8. P2 — backoff 중 offline 이벤트를 받으면 자동 reconnect가 영구 정체됨

- 위치: `src/sync/BoardClient.ts:221`
- 재현: 연결 종료 → 소켓이 없는 retry 대기 상태 → offline 이벤트 → online 이벤트.
- 원인: offline 처리에서 retry timer를 취소하지만 소켓이 없으면 close 이벤트도 없다. 상태는 `reconnecting`으로 남고, online handler는 `offline`일 때만 재시도한다.
- 수정: offline 이벤트 자체가 소켓을 무효화하고 pending/참가자/connection 상태를 갱신하도록 했다.
- 회귀: `test/BoardClient.test.ts`의 `reconnects after offline interrupts a backoff timer while there is no socket`.

### 9. P2 — 클라이언트가 malformed 서버 메시지를 검증 없이 수용함

- 위치: `shared/protocol.ts:169`, `src/sync/BoardClient.ts:177`
- 재현: 클라이언트에 `{"type":"op"}`, `cards:[null]` snapshot, 잘못된 participants, 음수 revision 등을 전달한다.
- 원인: `parseServerMessage`는 type이 문자열인지 확인한 뒤 타입 단언만 한다. 이후 null 접근 예외나 잘못된 상태 반영이 가능하다.
- 수정: 메시지별 필수 필드, safe integer version, 카드/참가자 구조 및 ID 중복을 검증한다. 잘못된 서버 프레임은 현재 연결을 닫아 재동기화로 복구한다. client update의 baseTextVersion도 음수/unsafe integer를 거부한다.
- 회귀: `test/adversarial.test.ts`의 malformed server frame 및 invalid textVersion 사례.

## 요청한 12개 invariant의 근거

| Invariant | 확인 결과 및 근거 |
|---|---|
| 동일 opId는 서버 상태를 한 번만 변경 | 기존 기본 dedupe 테스트 + 수정된 lifetime receipt/2000 초과 재전송 테스트 |
| reconnect snapshot + pending replay에서 중복 적용 방지 | 전송 이력이 있는 불확실한 op의 replay 보류, 삭제 카드/최신 위치 회귀 테스트 |
| ack 유실 → reconnect → resend 안전 | 최초 canonical 결과 재사용, 실제 Room과 BoardClient를 연결한 전송 경합 테스트 |
| delete 후 늦은 move/edit가 부활시키지 않음 | 기존 board delete/not_found 테스트 유지. 추가로 오래된 create resend에 의한 부활과 snapshot에서의 일시 부활 수정 |
| stale reject 후 draft 보존 | rejectedEdits 회귀 테스트 + 실제 두 탭에서 서버 reject가 도착하는 경합 검증 |
| 두 client의 같은 text 동시 수정 정책 | 기존 실제 WebSocket 통합 테스트의 첫 도착 승인/두 번째 stale reject 통과 |
| 다른 카드 수정이 서로 stale을 만들지 않음 | `applyOp(card.update)`가 대상 카드의 textVersion만 비교함을 코드로 확인. room revision은 stale 판정에 사용하지 않음 |
| 같은 origin 두 tab은 다른 client identity | App의 페이지별 ID 생성 코드를 확인하고 실제 동일 브라우저 context의 두 탭에서 ID가 다름을 검증 |
| disconnect/reconnect가 author identity를 훼손하지 않음 | createdBy/authorName이 카드에 보존됨. 기존 presence/reconnect 테스트 및 교체 연결·canonical author ack 회귀 테스트 |
| offline 생성 op가 reconnect 후 정확히 한 번 반영 | BoardClient에서 ack-lost create + offline create/edit/move 전송, 중복 resend 후 revision 유지 및 pending 0 검증 |
| out-of-order/malformed WebSocket이 서버 상태를 깨뜨리지 않음 | 기존 JSON 검증/선행 상태 검사, 특수 ID·프레임 오류·교체된 연결의 늦은 명령·거부 후 재시도 회귀 테스트. 클라이언트 gap 감지는 기존 테스트 유지 |
| 장시간 pending/confirmed/revision 일관성 | 2000 초과 기록 만료 결함 제거, 소켓 교체 시 resend 복구, 결과의 소유자 검증. 재시도 종료 후 view = confirmed = 서버 cards 및 revision 불변 확인 |

단일 정상 WebSocket 안에서는 전송 순서가 보장된다. 이번 out-of-order 검토는 상태보다 먼저 도착한 명령, 중복 재시도, revision gap, 연결 세대가 겹칠 때의 늦은 메시지를 대상으로 했다. 임의로 모든 서버 메시지를 재배열하는 별도 전송 프로토콜은 추가하지 않았다.

## 검증 결과

원본 기존 테스트는 5개 파일 / 32개 모두 통과했다. 결함 재현용 테스트를 추가한 첫 실행에서는 23개 실패와 WebSocket 미처리 예외 2개를 확인했다. 수정 후 소켓 소유권 회귀를 추가하여 총 27개 테스트가 늘었다.

repository에서 최종 실행:

| 명령 | 결과 |
|---|---|
| `npm test` | PASS — 7개 파일, 59개 테스트 |
| `npm run typecheck` | PASS |
| `npm run build` | PASS — TypeScript 검사 및 Vite production build |
| `git diff --check` | PASS — whitespace 오류 없음 |
| 별도 로컬 headless Edge 검사 | PASS — 같은 origin 두 탭 identity 분리, 실제 stale reject 후 textarea draft 복원 |

추가/수정한 테스트: `test/adversarial.test.ts`, `test/BoardClient.test.ts`, `test/ws.integration.test.ts`. 브라우저 검사는 프로젝트 외부의 로컬 Playwright 런타임을 사용했으며 프로젝트 의존성을 추가하지 않았다.

## 보장 범위와 비용

- 이 검증은 기존 설계대로 서버 메모리와 사용자 탭이 유지되는 동안의 동기화에 대한 것이다. 서버 재시작 시 room/receipt가 사라지고 탭 종료 시 pending이 사라지는 기존 수명 제한은 남아 있다.
- 무기한 늦은 재전송에 안전하려면 처리 기록을 임의로 버릴 수 없다. 최소 수정으로 receipt를 room 수명 동안 보관했으므로 저장 비용은 처리한 고유 op 수에 비례한다. 무제한 사용 시간에 대한 메모리 상한을 보장하는 변경은 아니다.
- snapshot 이후 적용 여부가 불명확한 기존 전송 op는 ack/reject를 받을 때까지 optimistic 표시를 보류한다. 한 번도 전송하지 않은 offline op는 기존처럼 optimistic 상태를 유지한다.
- 기존 정상 동작 테스트를 중복 작성하지 않았으며, 새로운 기능·스토리지·동기화 프로토콜 교체는 추가하지 않았다.
