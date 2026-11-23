import * as Phaser from 'phaser';
import { H_SCREEN, W } from './config';
import { RevealScene } from './scenes/RevealScene';
import { RunScene } from './scenes/RunScene';

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  width: W,
  height: H_SCREEN,
  backgroundColor: '#05060a',
  // 모바일: 고성능 GPU 우선, 픽셀 밀도는 1배(캔버스를 키우지 않음)
  render: { powerPreference: 'high-performance', antialias: true },
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  scene: [RunScene, RevealScene],
});

if (import.meta.env.DEV) (window as unknown as { __game: Phaser.Game }).__game = game;

