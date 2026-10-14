// 신계약 심사 마감 현황 챗봇: 브라우저 → /api/chat → OpenRouter (무료 Nemotron)
// API 키는 Vercel 환경변수(OPENROUTER_API_KEY)에만 두고 브라우저로 보내지 않는다.
const MODEL = process.env.OPENROUTER_MODEL || "nvidia/nemotron-3-super-120b-a12b:free";

const SYSTEM = `당신은 보험사 계약심사부의 '신계약 심사 마감 현황' 도우미입니다.
- 한국어로, 짧고 정확하게 답합니다. 보고서에 옮길 문장은 보고서체(~임, ~함)로 씁니다.
- 숫자는 아래 [현재 화면 데이터]에 있는 값만 씁니다. 데이터에 없는 값은 추측하지 말고 "화면 데이터에 없음"이라고 말합니다.
- 간단한 계산(차이, 비율)은 해도 되지만 계산했다는 것을 밝힙니다.
- 지표 정의와 점검 규칙은 데이터에 적힌 정의를 따릅니다.
- 표가 필요하면 간단한 목록으로 정리합니다.`;

const MAX_MESSAGES = 20;
const MAX_CHARS = 8000;
const MAX_CONTEXT = 60000;

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST 요청만 받습니다." });
  }
  const key = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY;
  if (!key) {
    return res.status(500).json({ error: "서버에 OPENROUTER_API_KEY 환경변수가 없습니다. Vercel 프로젝트 설정에서 추가해 주세요." });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
  const raw = Array.isArray(body && body.messages) ? body.messages : [];
  const messages = raw
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .slice(-MAX_MESSAGES)
    .map(m => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return res.status(400).json({ error: "마지막 메시지는 사용자 질문이어야 합니다." });
  }
  const context = typeof body.context === "string" ? body.context.slice(0, MAX_CONTEXT) : "";
  const system = SYSTEM + (context ? `\n\n[현재 화면 데이터]\n${context}` : "");

  let upstream;
  try {
    upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": req.headers.origin || `https://${req.headers.host || "localhost"}`,
        "X-Title": "UW Metrics Chatbot",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "system", content: system }, ...messages],
        stream: true,
        temperature: 0.3,
        max_tokens: 1500,
        reasoning: { exclude: true },
      }),
    });
  } catch (e) {
    return res.status(502).json({ error: "OpenRouter에 연결하지 못했습니다." });
  }
  if (!upstream.ok || !upstream.body) {
    const detail = (await upstream.text().catch(() => "")).slice(0, 300);
    const msg = upstream.status === 429 ? "무료 모델 사용 한도에 걸렸습니다. 잠시 뒤 다시 시도해 주세요."
      : upstream.status === 401 ? "OpenRouter API 키가 올바르지 않습니다."
      : `모델 호출에 실패했습니다 (${upstream.status}).`;
    return res.status(upstream.status === 429 ? 429 : 502).json({ error: msg, detail });
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Model", MODEL);

  // OpenRouter SSE → 답변 텍스트만 그대로 흘려보낸다 (추론 토큰·keep-alive 주석은 버림)
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") { res.end(); return; }
        let j;
        try { j = JSON.parse(data); } catch { continue; }
        if (j.error) { res.write(`\n\n[오류] ${j.error.message || "모델 응답 중 오류가 났습니다."}`); continue; }
        const piece = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (piece) res.write(piece);
      }
    }
  } catch (e) {
    res.write("\n\n[오류] 응답이 중간에 끊겼습니다.");
  }
  res.end();
};
