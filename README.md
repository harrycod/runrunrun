# Parallel Lives

Phaser 4 + TypeScript + Vite 기반 아케이드 게임.

빛 한 점으로 어두운 동굴을 끝까지 올라가는 짧은 런 게임이다.
겉으로는 고스트 리플레이가 있는 평범한 아케이드 게임이지만, 꼭대기에 닿으면
지금까지 했던 모든 판이 한 그루의 나무로 자라난다. 줄기는 마지막 판(지금의 나),
가지는 끝난 판들(선택하지 않은 평행세계의 나), 꽃은 나비에 밀렸던 자리다.

## 실행

```bash
npm install
npm run dev     # 개발 서버 (같은 Wi-Fi의 휴대폰은 터미널의 Network 주소로 접속)
npm run build   # 타입체크 + 프로덕션 빌드
```

## 조작

- `←` `→` / `A` `D` 또는 마우스: 좌우 이동
- 모바일(자동 판별): 화면 아무 곳이나 대고 좌우로 끌기. 손가락이 움직인 만큼(1.5배) 빛이 움직이고, 떼면 그 자리에서 곧게 올라간다
- `M`: 소리 끄기/켜기
- `R`: (개발용) 기록 초기화

## 구조

```
src/
  config.ts              # 화면/동굴 크기, 시드
  level/cave.ts          # 시드 기반 동굴 생성 (외길·갈림길·빛 조각·나비), 충돌 판정
  runs/runStore.ts       # 판 기록 (localStorage)
  scenes/RunScene.ts     # 플레이: 이동, 빛 소모, 고스트, 마지막 어둠 구간의 길잡이 빛
  reveal/tree.ts         # 모든 판의 궤적을 나무 구조로 엮는 레이아웃
  scenes/RevealScene.ts  # 반전 엔딩: 나무가 자라고 꽃이 피는 연출
  audio/sfx.ts           # 합성 효과음 (Web Audio)
  audio/music.ts         # 배경음악: 루프 크로스페이드, 마지막 구간 로우패스
```
## 오디오

- `public/audio/{run,tree}.{ogg,m4a}` — 브라우저가 ogg(Opus)를 못 읽으면 m4a(AAC)를 쓴다
- `audio-src/` — Suno 원본 (Opus 코덱이 든 m4a). 게임에서는 쓰지 않는다
- 재변환: `ffmpeg -i audio-src/run.opus.m4a -vn -c:a copy public/audio/run.ogg` / `ffmpeg -i audio-src/run.opus.m4a -vn -c:a aac_at -b:a 160k public/audio/run.m4a`

