// src/kakao.js
//
// Tiny helpers for the Kakao i OpenBuilder skill response format.
// Reference: https://i.kakao.com/docs/skill-response-format

// Wrap a plain-text string in the "simpleText" response shape.
export function simpleText(text) {
  return {
    version: '2.0',
    template: {
      outputs: [{ simpleText: { text } }],
    },
  };
}

// Immediate response that tells OpenBuilder to wait for a callback.
export function useCallbackResponse(waitingText = '답변을 생성하고 있습니다...') {
  return {
    version: '2.0',
    useCallback: true,
    data: { text: waitingText },
  };
}

// Pull the user's utterance (the question) out of a skill request.
export function extractUtterance(reqBody) {
  return reqBody?.userRequest?.utterance ?? '';
}

// Pull the callback URL (only present when callback mode is enabled in OpenBuilder).
export function extractCallbackUrl(reqBody) {
  return reqBody?.userRequest?.callbackUrl ?? null;
}
