import type { EditorState, Extension } from '@codemirror/state';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import type { FC, ReactNode } from 'react';
import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import {
  AudioPlayerContextValue,
  CurrentTimeDisplay,
  DurationDisplay,
  formatTime,
  PlaybackRateControl,
  PlayTrigger,
  ProgressIndicator,
  RootProvider,
  StopTrigger,
  Timeline,
  VolumeControl,
  Waveform,
  useCurrentPlayer,
} from '@waveform-audio/player';
import { Plugin, TFile, PluginSettingTab, Setting, App } from 'obsidian';
import { createElement, useState, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import L from './L';

const PLAYER_CLASS = 'waveform-player-widget';
const AUDIO_LINK_PATTERN = '!\\[([^\\]]*)\\]\\(([^)#]+\\.(?:mp3|wav|ogg|m4a|webm|flac))(#t=[^)]*)?[^)]*\\)|!\\[\\[([^\\]#]+\\.(?:mp3|wav|ogg|m4a|webm|flac))(#t=[^\\]]*)?[^\\]]*\\]\\]';

// Parse a Media Fragment URI timestamp (#t=...) into seconds.
// Supports: #t=90, #t=1:30, #t=1:30:00
function parseTimestamp(fragment: string | undefined): number {
  if (!fragment) return 0;
  const match = fragment.match(/#t=([^,]+)/);
  if (!match) return 0;
  const parts = match[1].split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

// 波形类型枚举
type WaveformType = 'bars' | 'envelope' | 'line' | 'mirror' | 'wave';

// 插件设置接口
interface WaveformPlayerSettings {
  stopOthersOnPlay: boolean;
  waveformType: WaveformType;
  samplePoints: number; // 采样点数量
}

// 默认设置
const DEFAULT_SETTINGS: WaveformPlayerSettings = {
  stopOthersOnPlay: true,
  waveformType: 'mirror',
  samplePoints: 200, // 默认采样点数量
};

// 全局音频播放器注册表
let audioPlayerContexts: AudioPlayerContextValue[] = [];

// Seek registry: vault src path → AudioPlayerContextValue (for seek buttons)
let playerRegistry: Map<string, AudioPlayerContextValue> = new Map();

// 阅读视图播放器信息存储
interface ReadingViewPlayerInfo {
  root: ReturnType<typeof createRoot>;
  container: HTMLElement;
  playerDiv: HTMLElement;
  audioUrl: string;
  title: string;
  startTime: number;
  fileSrc: string;
}

// 播放器属性接口，用于统一创建播放器组件
interface PlayerProps {
  src: string;
  vaultSrc: string;
  title: string;
  plugin: WaveformPlayerPlugin;
  id?: string;
}

// Button that copies a seek link for the current playback position.
// Must be rendered inside a RootProvider so useCurrentPlayer() works.
const CopySeekButton: FC<{ vaultSrc: string }> = ({ vaultSrc }) => {
  const ctx = useCurrentPlayer();
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const [copied, setCopied] = useState(false);

  const handleClick = useCallback(() => {
    const t = Math.floor(ctxRef.current.currentTime);
    const filename = vaultSrc.split('/').pop() || vaultSrc;
    const link = `![[${filename}#t=${t}]]`;
    navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [vaultSrc]);

  return createElement('button', {
    className: 'waveform-copy-seek-button',
    onClick: handleClick,
    title: 'Copy seek link',
  },
    copied
      ? createElement('span', { className: 'waveform-copy-check' }, '✓')
      : createElement('span', { className: 'waveform-copy-icon' }),
  );
};

// 创建播放器React元素的统一函数
function createPlayerElement({ src, vaultSrc, title, plugin, id }: PlayerProps): ReactNode {
  const { waveformType, samplePoints } = plugin.settings;
  return createElement(
    RootProvider as FC<any>,
    {
      key: id,
      src,
      samplePoints,
      onPlay: (ctx: AudioPlayerContextValue) => {
        playerRegistry.set(vaultSrc, ctx);
        if (plugin.settings.stopOthersOnPlay) {
          audioPlayerContexts.forEach(player => {
            if (player.instanceId !== ctx.instanceId) player.pause();
          });
        }
        audioPlayerContexts.push(ctx);
      },
      onPause: (ctx: AudioPlayerContextValue) => {
        audioPlayerContexts = audioPlayerContexts.filter(p => p.instanceId !== ctx.instanceId);
      },
      onEnded: (ctx: AudioPlayerContextValue) => {
        audioPlayerContexts = audioPlayerContexts.filter(p => p.instanceId !== ctx.instanceId);
      },
    },
    createElement('div', { className: 'wa-player wa-obsidian-player' },
      // Header
      createElement('div', { className: 'wa-header', style: { padding: 0, paddingBottom: 8 } },
        createElement('div', {
          className: 'wa-title wa-truncate',
          style: { fontSize: '14px', margin: 0 },
        }, title),
      ),
      // Body row: controls (left) + waveform (right)
      createElement('div', { className: 'wa-flex wa-h-full' },
        // Left: controls column
        createElement('div', {
          className: 'wa-controls wa-flex wa-flex-col wa-justify-center wa-shrink-0 wa-items-start wa-gap-2',
          style: { width: 'fit-content', minWidth: '0', padding: 0 },
        },
          // Play + Stop
          createElement('div', { className: 'wa-flex wa-items-end wa-gap-4' },
            createElement(PlayTrigger as FC<any>, { className: 'wa-play-button wa-w-12 wa-h-12' }),
            createElement(StopTrigger as FC<any>, { className: 'wa-stop-button' }),
          ),
          // Time display
          createElement('div', { className: 'wa-flex wa-items-end wa-space-x-2' },
            createElement(CurrentTimeDisplay as FC<any>, {
              className: 'wa-time-display wa-font-mono wa-text-[var(--wa-text-secondary-color)] wa-leading-none',
            }),
            createElement('span', {
              className: 'wa-text-[var(--wa-text-secondary-color)] wa-text-sm wa-leading-none wa-opacity-70',
            }, '/'),
            createElement(DurationDisplay as FC<any>, {
              className: 'wa-font-mono wa-text-[var(--wa-text-secondary-color)] wa-text-sm wa-leading-none wa-opacity-70',
            }),
          ),
          // Volume + Speed + Copy button
          createElement('div', { className: 'wa-flex wa-items-center wa-gap-2' },
            createElement(VolumeControl as FC<any>),
            createElement(PlaybackRateControl as FC<any>),
            createElement(CopySeekButton, { vaultSrc }),
          ),
        ),
        // Right: waveform column
        createElement('div', { className: 'wa-w-full wa-group' },
          createElement('div', { className: 'wa-timeline' },
            createElement(Timeline as FC<any>, { color: '#9ca3af' }),
          ),
          createElement('div', { className: 'wa-relative wa-w-full' },
            createElement(Waveform as FC<any>, {
              className: 'wa-waveform wa-w-full',
              style: { height: '100px' },
              type: waveformType,
              barWidth: 3,
              barGap: 2,
              barRadius: 2,
              samplePoints,
            }),
            createElement(ProgressIndicator as FC<any>, {
              className: 'wa-progress-indicator',
              overlay: true,
            }),
          ),
        ),
      ),
    ),
  );
}

class AudioPlayerWidget extends WidgetType {
  private static counter = 0;
  private container: HTMLElement | null = null;
  private readonly id: string;
  private mounted = false;
  private playerDiv: HTMLElement | null = null;
  private root: null | ReturnType<typeof createRoot> = null;
  // 记录创建时的设置版本，用于检测设置是否变化
  private settingsVersion: number;

  // 存储所有实例的静态集合
  private static instances: Set<AudioPlayerWidget> = new Set();

  // 静态触发器，用于手动触发重新渲染所有播放器
  public static updateTrigger = StateEffect.define<void>();

  constructor(
    private readonly src: string,
    private readonly title: string,
    private readonly plugin: WaveformPlayerPlugin,
    private readonly startTime: number = 0,
  ) {
    super();
    this.id = `audio-player-${AudioPlayerWidget.counter++}`;
    // 记录当前的设置版本
    this.settingsVersion = this.plugin.settingsVersion;
    // 将实例添加到集合中
    AudioPlayerWidget.instances.add(this);
  }

  destroy() {
    // 从集合中移除实例
    AudioPlayerWidget.instances.delete(this);
    this.unmount();
    this.container = null;
    this.playerDiv = null;
  }

  // 静态方法：重新渲染所有播放器实例
  static refreshAllPlayers(plugin: WaveformPlayerPlugin): void {
    // 触发编辑器强制更新
    plugin.triggerEditorRefresh();
  }

  // 重新挂载播放器
  remount(): void {
    if (this.playerDiv && this.container) {
      this.unmount();
      this.mount();
    }
  }

  // 当比较两个播放器小部件是否相同时，同时考虑设置版本
  eq(other: AudioPlayerWidget): boolean {
    return (
      other instanceof AudioPlayerWidget &&
      this.src === other.src &&
      this.title === other.title &&
      this.startTime === other.startTime &&
      this.settingsVersion === other.settingsVersion // 比较设置版本
    );
  }

  toDOM() {
    if (this.container) {
      this.unmount();
    }

    const container = document.createElement('div');
    container.className = `${PLAYER_CLASS}-container`;
    container.dataset.playerId = this.id;

    const playerDiv = document.createElement('div');
    playerDiv.className = PLAYER_CLASS;
    container.appendChild(playerDiv);

    this.container = container;
    this.playerDiv = playerDiv;

    // 使用 requestIdleCallback 延迟挂载，优化性能
    if (window.requestIdleCallback) {
      window.requestIdleCallback(() => this.mount());
    }
    else {
      setTimeout(() => this.mount(), 0);
    }

    return container;
  }

  private mount() {
    if (!this.playerDiv || !this.container || this.mounted) {
      return;
    }
    const audioFile = this.plugin.getAudioFile(this.src);
    if (!audioFile) {
      console.warn('[AudioPlayerWidget] Audio file not found:', this.src);
      return;
    }

    const audioUrl = this.plugin.app.vault.getResourcePath(audioFile);
    const decodedUrl = decodeURIComponent(audioUrl);
    const srcWithTimestamp = this.startTime > 0 ? `${decodedUrl}#t=${this.startTime}` : decodedUrl;

    try {
      this.root = createRoot(this.playerDiv);
      this.root.render(
        createPlayerElement({
          src: srcWithTimestamp,
          vaultSrc: this.src,
          title: this.title || audioFile.basename,
          plugin: this.plugin,
          id: this.id
        })
      );
      this.mounted = true;
    }
    catch (error) {
      console.error('[AudioPlayerWidget] Failed to mount player:', error);
    }
  }

  private unmount() {
    if (this.root) {
      try {
        this.root.unmount();
      }
      catch (error) {
        console.error('[AudioPlayerWidget] Failed to unmount player:', error);
      }
      this.root = null;
    }
    if (this.playerDiv) {
      this.playerDiv.innerHTML = '';
    }
    this.mounted = false;
  }
}

class SeekButtonWidget extends WidgetType {
  constructor(
    private readonly src: string,
    private readonly startTime: number,
  ) {
    super();
  }

  eq(other: SeekButtonWidget): boolean {
    return other instanceof SeekButtonWidget && this.src === other.src && this.startTime === other.startTime;
  }

  toDOM(): HTMLElement {
    const button = document.createElement('button');
    button.className = 'waveform-seek-button';
    button.createSpan({ cls: 'waveform-seek-button-icon', text: '▶' });
    button.createSpan({ cls: 'waveform-seek-button-label', text: formatTime(this.startTime) });
    button.addEventListener('click', () => {
      const ctx = playerRegistry.get(this.src);
      if (ctx) {
        ctx.seek(this.startTime);
        ctx.play();
      }
    });
    return button;
  }
}

export default class WaveformPlayerPlugin extends Plugin {
  settings: WaveformPlayerSettings = DEFAULT_SETTINGS;
  // 设置版本号，每次设置变更时递增
  settingsVersion: number = 0;
  // 存储阅读视图中渲染的播放器
  private readingViewPlayers: ReadingViewPlayerInfo[] = [];
  // 编辑器视图
  private editorViews: Set<EditorView> = new Set();

  // 触发编辑器视图刷新
  triggerEditorRefresh(): void {
    this.editorViews.forEach(view => {
      view.dispatch({
        effects: AudioPlayerWidget.updateTrigger.of(undefined)
      });
    });
  }

  // 更新所有播放器
  refreshAllPlayers(): void {
    // 增加设置版本号
    this.settingsVersion++;

    // 更新编辑器视图中的播放器
    AudioPlayerWidget.refreshAllPlayers(this);

    // 更新阅读视图中的播放器
    this.refreshReadingViewPlayers();

    // 通知用户刷新完成
    this.app.workspace.trigger('waveform-player:refresh-complete');
  }

  // 刷新阅读视图播放器
  private refreshReadingViewPlayers(): void {
    this.readingViewPlayers.forEach(playerInfo => {
      try {
        // 卸载并重新渲染播放器
        playerInfo.root.unmount();
        const root = createRoot(playerInfo.playerDiv);

        root.render(
          createPlayerElement({
            src: playerInfo.audioUrl,
            vaultSrc: playerInfo.fileSrc,
            title: playerInfo.title,
            plugin: this
          })
        );

        // 更新播放器根节点引用
        playerInfo.root = root;
      } catch (error) {
        console.error('[WaveformPlayerPlugin] Failed to refresh reading view player:', error);
      }
    });
  }

  createEditorExtension(): Extension {
    const updateAudioPlayers = StateEffect.define<void>();
    const plugin = this;

    const audioPlayerField = StateField.define<DecorationSet>({
      create: (state) => {
        return this.buildDecorations(state);
      },
      provide: field => EditorView.decorations.from(field),
      update: (decorations, tr) => {
        if (!tr.docChanged &&
          !tr.effects.some(e => e.is(updateAudioPlayers)) &&
          !tr.effects.some(e => e.is(AudioPlayerWidget.updateTrigger))) {
          return decorations;
        }

        const changes = tr.changes;
        let needsUpdate = false;

        if (tr.docChanged) {
          const regex = new RegExp(AUDIO_LINK_PATTERN);
          /* @ts-ignore */
          changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
            const insertedText = inserted.toString();
            const hasAudioLink = regex.test(insertedText);
            if (hasAudioLink) {
              needsUpdate = true;
            }
          });
        }

        // 如果是设置更新触发器，强制更新
        if (tr.effects.some(e => e.is(AudioPlayerWidget.updateTrigger))) {
          needsUpdate = true;
        }

        if (!needsUpdate && !tr.effects.some(e => e.is(updateAudioPlayers))) {
          return decorations;
        }

        return this.buildDecorations(tr.state);
      },
    });

    const viewportPlugin = ViewPlugin.fromClass(class {
      private updateScheduled = false;
      private timeout: number | null = null;

      constructor(private readonly view: EditorView) {
        this.scheduleUpdate();
        // 注册编辑器视图
        plugin.editorViews.add(view);
      }

      destroy() {
        if (this.timeout) {
          clearTimeout(this.timeout);
        }
        // 移除编辑器视图
        plugin.editorViews.delete(this.view);
      }

      update(update: ViewUpdate) {
        if (update.viewportChanged) {
          this.scheduleUpdate();
        }
      }

      private scheduleUpdate() {
        if (this.updateScheduled) {
          return;
        }
        this.updateScheduled = true;

        if (this.timeout) {
          clearTimeout(this.timeout);
        }

        this.timeout = window.setTimeout(() => {
          this.updateScheduled = false;
          this.view.dispatch({
            effects: updateAudioPlayers.of(undefined),
          });
        }, 200);
      }
    });

    return [audioPlayerField, viewportPlugin];
  }

  getAudioFile(src: string): null | TFile {
    const audioFile = this.app.metadataCache.getFirstLinkpathDest(src, '');
    return audioFile instanceof TFile ? audioFile : null;
  }

  async onload() {
    // 加载设置
    await this.loadSettings();

    // 添加设置选项卡
    this.addSettingTab(new WaveformPlayerSettingTab(this.app, this));

    // 注册编辑器扩展
    this.registerEditorExtension(this.createEditorExtension());

    // Intercept clicks on [[audio.mp3#t=N|text]] wiki links to seek instead of navigate.
    // Must use capture phase so we run before Obsidian's own link navigation handler.
    this.registerDomEvent(document, 'click', (e: MouseEvent) => {
      const target = e.target as HTMLElement;

      // Reading view: <a class="internal-link" data-href="file.mp3#t=N">
      // Editor view:  span with data-href inside .cm-hmd-internal-link
      const el = target.closest('a.internal-link, [data-href]') as HTMLElement | null;
      if (!el) return;

      const href = el.getAttribute('data-href') || (el as HTMLAnchorElement).href || '';
      const match = href.match(/^([^#]+\.(?:mp3|wav|ogg|m4a|webm|flac))#t=(.+)$/i);
      if (!match) return;

      const fileSrc = match[1];
      const startTime = parseTimestamp('#t=' + match[2]);
      if (startTime <= 0) return;

      // Always stop navigation for audio#t= links, whether or not the player is ready
      e.preventDefault();
      e.stopImmediatePropagation();

      const ctx = playerRegistry.get(fileSrc);
      if (ctx) {
        ctx.seek(startTime);
        ctx.play();
      }
    }, { capture: true });

    // 注册 Markdown 后处理器（用于阅读视图）
    this.registerMarkdownPostProcessor((element) => {
      const audioElements = element.querySelectorAll('.internal-embed');
      const seenInThisElement = new Set<string>();

      audioElements.forEach((div) => {
        const srcAttr = div.getAttribute('src') || '';
        const srcMatch = srcAttr.match(/^([^#]+)(#t=.*)?$/);
        if (!srcMatch) return;
        const fileSrc = srcMatch[1];
        const startTime = parseTimestamp(srcMatch[2]);
        if (!/\.(?:mp3|wav|ogg|m4a|webm|flac)$/i.test(fileSrc)) {
          return;
        }

        const audioFile = this.getAudioFile(fileSrc);
        if (!audioFile) {
          return;
        }

        // Check if this src already has a full player rendered (in this element or earlier)
        const alreadyRendered = (seenInThisElement.has(fileSrc) ||
          this.readingViewPlayers.some(p => p.fileSrc === fileSrc)) && startTime > 0;

        if (alreadyRendered) {
          // Render a seek button instead
          const button = document.createElement('button');
          button.className = 'waveform-seek-button';
          button.createSpan({ cls: 'waveform-seek-button-icon', text: '▶' });
          button.createSpan({ cls: 'waveform-seek-button-label', text: formatTime(startTime) });
          button.addEventListener('click', () => {
            const ctx = playerRegistry.get(fileSrc);
            if (ctx) {
              ctx.seek(startTime);
              ctx.play();
            }
          });
          div.parentNode?.insertBefore(button, div.nextSibling);
          return;
        }

        seenInThisElement.add(fileSrc);

        const audioUrl = this.app.vault.getResourcePath(audioFile);
        const decodedUrl = decodeURIComponent(audioUrl);
        const decodedUrl_ts = startTime > 0 ? `${decodedUrl}#t=${startTime}` : decodedUrl;

        const container = document.createElement('div');
        container.className = `${PLAYER_CLASS}-container`;

        const playerDiv = document.createElement('div');
        playerDiv.className = PLAYER_CLASS;
        container.appendChild(playerDiv);

        // 在原有元素后面插入播放器
        div.parentNode?.insertBefore(container, div.nextSibling);

        const root = createRoot(playerDiv);

        // 创建播放器信息并存储
        const playerInfo: ReadingViewPlayerInfo = {
          root,
          container,
          playerDiv,
          audioUrl: decodedUrl_ts,
          title: audioFile.basename,
          startTime,
          fileSrc,
        };

        // 将播放器信息添加到列表中
        this.readingViewPlayers.push(playerInfo);

        // 当组件卸载时，从列表中移除
        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            for (const node of Array.from(mutation.removedNodes)) {
              if (node.contains(container)) {
                this.readingViewPlayers = this.readingViewPlayers.filter(p => p !== playerInfo);
                observer.disconnect();
                return;
              }
            }
          }
        });

        // 监视 DOM 变化
        if (div.parentNode) {
          observer.observe(div.parentNode, { childList: true, subtree: true });
        }

        root.render(
          createPlayerElement({
            src: decodedUrl_ts,
            vaultSrc: fileSrc,
            title: audioFile.basename,
            plugin: this
          })
        );
      });
    });
  }

  onunload() {
    // 清理所有播放器
    this.readingViewPlayers.forEach(playerInfo => {
      try {
        playerInfo.root.unmount();
      } catch (error) {
        console.error('[WaveformPlayerPlugin] Failed to unmount reading view player:', error);
      }
    });
    this.readingViewPlayers = [];
    this.editorViews.clear();

    audioPlayerContexts.forEach(ctx => ctx.stop());
    audioPlayerContexts = [];
    playerRegistry.clear();
  }

  // 加载设置
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  // 保存设置
  async saveSettings() {
    await this.saveData(this.settings);
  }

  private buildDecorations(state: EditorState): DecorationSet {
    const widgets: any[] = [];
    const doc = state.doc;
    const seenSrcs = new Set<string>();

    // 遍历所有行，注意 CodeMirror 6 中行号从 1 开始
    for (let lineNo = 1; lineNo <= doc.lines; lineNo++) {
      const line = doc.line(lineNo);
      const lineText = line.text;

      // 每次创建新的正则表达式实例
      const regex = new RegExp(AUDIO_LINK_PATTERN, 'gi');

      Array.from(lineText.matchAll(regex)).forEach((match) => {
        const [_, title, mdSrc, mdTimestamp, obsidianSrc, obsidianTimestamp] = match;
        // 如果是 Obsidian 格式的链接，使用 obsidianSrc 作为源和标题
        const src = obsidianSrc || mdSrc;
        const effectiveTitle = obsidianSrc ? obsidianSrc.split('/').pop()?.replace(/\.[^.]+$/, '') || '' : (title || '');
        const startTime = parseTimestamp(obsidianTimestamp || mdTimestamp);

        if (!src) {
          return;
        }

        const matchStart = line.from + match.index!;
        const matchEnd = matchStart + match[0].length;

        if (seenSrcs.has(src) && startTime > 0) {
          // Subsequent occurrence with a timestamp: block widget (inline hides with fold)
          widgets.push(
            Decoration.widget({
              block: true,
              side: 1,
              widget: new SeekButtonWidget(src, startTime),
            }).range(matchEnd),
          );
        } else {
          seenSrcs.add(src);
          // 添加播放器装饰器，直接在链接后面插入
          widgets.push(
            Decoration.widget({
              block: true,
              persistent: true,
              side: 1,
              widget: new AudioPlayerWidget(src, effectiveTitle, this, startTime),
            }).range(matchEnd),
          );
        }
      });
    }

    return Decoration.set(widgets, true);
  }
}

// 设置选项卡类
class WaveformPlayerSettingTab extends PluginSettingTab {
  plugin: WaveformPlayerPlugin;

  constructor(app: App, plugin: WaveformPlayerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();

    new Setting(containerEl)
      .setName(L.settings.stopOtherPlayers.title())
      .setDesc(L.settings.stopOtherPlayers.description())
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.stopOthersOnPlay)
        .onChange(async (value) => {
          this.plugin.settings.stopOthersOnPlay = value;
          await this.plugin.saveSettings();
          // 设置变化时刷新所有播放器
          this.plugin.refreshAllPlayers();
        }));

    new Setting(containerEl)
      .setName(L.settings.waveformType.title())
      .setDesc(L.settings.waveformType.description())
      .addDropdown(dropdown => dropdown
        .addOptions({
          'bars': L.settings.waveformType.options.bars(),
          'envelope': L.settings.waveformType.options.envelope(),
          'line': L.settings.waveformType.options.line(),
          'mirror': L.settings.waveformType.options.mirror(),
          'wave': L.settings.waveformType.options.wave()
        })
        .setValue(this.plugin.settings.waveformType)
        .onChange(async (value: string) => {
          this.plugin.settings.waveformType = value as WaveformType;
          await this.plugin.saveSettings();
          // 设置变化时刷新所有播放器
          this.plugin.refreshAllPlayers();
        }));

    new Setting(containerEl)
      .setName(L.settings.samplePoints.title())
      .setDesc(L.settings.samplePoints.description())
      .addDropdown(dropdown => dropdown
        .addOptions({
          '50': L.settings.samplePoints.options[50](),
          '100': L.settings.samplePoints.options[100](),
          '200': L.settings.samplePoints.options[200](),
          '500': L.settings.samplePoints.options[500](),
          '1000': L.settings.samplePoints.options[1000](),
          '2000': L.settings.samplePoints.options[2000](),
          '5000': L.settings.samplePoints.options[5000]()
        })
        .setValue(this.plugin.settings.samplePoints.toString())
        .onChange(async (value: string) => {
          this.plugin.settings.samplePoints = parseInt(value, 10);
          await this.plugin.saveSettings();
          // 设置变化时刷新所有播放器
          this.plugin.refreshAllPlayers();
        }));
  }
}
