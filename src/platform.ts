/**
 * 모바일(터치가 주 입력인 기기) 여부. 시작할 때 한 번 판단한다.
 * - 주 포인터가 손가락처럼 '거친' 입력인지 (pointer: coarse)
 * - 휴대폰/태블릿 User-Agent
 * - 데스크톱 UA로 보이는 iPadOS (Macintosh + 멀티터치)
 */
function detectMobile(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = navigator.userAgent;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const mobileUa = /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(ua);
  const iPadOS = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  return coarse || mobileUa || iPadOS;
}

export const IS_MOBILE = detectMobile();
