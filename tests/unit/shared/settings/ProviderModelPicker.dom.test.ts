/**
 * @jest-environment jsdom
 */

jest.mock('obsidian', () => ({
  Setting: class MockSetting {
    settingEl = document.createElement('div');

    constructor(container: HTMLElement) {
      container.appendChild(this.settingEl);
    }

    setDesc(): this {
      return this;
    }

    setName(): this {
      return this;
    }
  },
}));

import { within } from '@testing-library/dom';
import { configureAxe } from 'jest-axe';

import {
  type ProviderModelPickerOptions,
  type ProviderModelPickerState,
  renderProviderModelPicker,
} from '@/shared/settings/ProviderModelPicker';

const LOADING_TEXT = 'Loading model catalog...';
const EMPTY_TEXT = 'No models discovered.';
const FAILED_TEXT = 'Could not load the model catalog.';

const checkAccessibility = configureAxe({ rules: { region: { enabled: false } } });

function emptyState(): ProviderModelPickerState {
  return { aliases: {}, discoveredCount: 0, models: [], selectedIds: [] };
}

function populatedState(): ProviderModelPickerState {
  return {
    aliases: {},
    discoveredCount: 2,
    models: [
      { id: 'model-one', name: 'Model One', providerKey: 'test', providerLabel: 'Test provider' },
      { id: 'model-two', name: 'Model Two', providerKey: 'test', providerLabel: 'Test provider' },
    ],
    selectedIds: ['model-one'],
  };
}

function buildOptions(
  container: HTMLElement,
  loadCatalog: ProviderModelPickerOptions['loadCatalog'],
  getState: () => ProviderModelPickerState = emptyState,
): ProviderModelPickerOptions {
  return {
    container,
    emptyCatalogText: EMPTY_TEXT,
    failedCatalogText: FAILED_TEXT,
    getState,
    initiallyOpen: true,
    loadCatalog,
    loadingCatalogText: LOADING_TEXT,
    modifier: 'test',
    onAliasesChange: async () => undefined,
    onSelectedIdsChange: async () => undefined,
    providerName: 'Test provider',
  };
}

function getPickerEl(container: HTMLElement): HTMLElement {
  const pickerEl = container.querySelector<HTMLElement>('.claudian-provider-model-picker');
  if (!pickerEl) {
    throw new Error('picker root not found');
  }
  return pickerEl;
}

function getCatalogEl(container: HTMLElement): HTMLElement {
  const catalogEl = container.querySelector<HTMLElement>('.claudian-provider-model-picker-catalog');
  if (!catalogEl) {
    throw new Error('picker catalog not found');
  }
  return catalogEl;
}

function getStatusEl(container: HTMLElement): HTMLElement {
  return within(container).getByRole('status');
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
}

function captureHostFrames(): FrameRequestCallback[] {
  const frames: FrameRequestCallback[] = [];
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
    frames.push(callback);
    return frames.length;
  });
  return frames;
}

/** Drains queued microtasks and animation frames until the picker settles. */
async function flush(frames: FrameRequestCallback[]): Promise<void> {
  await settle();
  for (let guard = 0; guard < 10 && frames.length > 0; guard += 1) {
    const frame = frames.shift();
    frame?.(0);
    await settle();
  }
}

describe('renderProviderModelPicker discovery status', () => {
  beforeAll(() => {
    if (!HTMLElement.prototype.addClass) {
      HTMLElement.prototype.addClass = function addClass(this: HTMLElement, ...classes: string[]) {
        this.classList.add(...classes);
      };
    }
    if (!HTMLElement.prototype.empty) {
      HTMLElement.prototype.empty = function empty(this: HTMLElement) {
        this.replaceChildren();
      };
    }
    if (!HTMLElement.prototype.toggleClass) {
      HTMLElement.prototype.toggleClass = function toggleClass(
        this: HTMLElement,
        classes: string | string[],
        value: boolean,
      ) {
        const list = Array.isArray(classes) ? classes : [classes];
        for (const cls of list) {
          this.classList.toggle(cls, value);
        }
      };
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
    document.body.replaceChildren();
  });

  it('exposes a persistent polite status region that starts empty', async () => {
    const frames = captureHostFrames();
    const loadCatalog = jest.fn(async (): Promise<'failed'> => 'failed');
    const container = document.body.appendChild(document.createElement('div'));
    const state = populatedState();

    renderProviderModelPicker(buildOptions(container, loadCatalog, () => state));
    await flush(frames);

    const statusEl = getStatusEl(container);
    expect(statusEl.getAttribute('aria-live')).toBe('polite');
    expect(statusEl.textContent).toBe('');
    expect(getCatalogEl(container).contains(statusEl)).toBe(false);
  });

  it('announces discovery start and the empty outcome', async () => {
    const frames = captureHostFrames();
    const loadCatalog = jest.fn(async (): Promise<'empty'> => 'empty');
    const container = document.body.appendChild(document.createElement('div'));

    renderProviderModelPicker(buildOptions(container, loadCatalog));

    // The catalog renders open, so it performs its own first discovery pass.
    await flush(frames);

    const statusEl = getStatusEl(container);
    expect(loadCatalog).toHaveBeenNthCalledWith(1, false);
    expect(statusEl.textContent).toBe(EMPTY_TEXT);

    const discoverButton = within(container).getByRole('button', { name: 'Discover' });
    expect(discoverButton.getAttribute('type')).toBe('button');
    discoverButton.click();

    expect(statusEl.textContent).toBe(LOADING_TEXT);
    expect((discoverButton as HTMLButtonElement).disabled).toBe(true);
    expect(within(container).getByRole('button', { name: 'Loading...' })).toBe(discoverButton);
    expect(getCatalogEl(container).getAttribute('aria-busy')).toBe('true');
    expect(loadCatalog).toHaveBeenCalledTimes(1);

    await flush(frames);

    expect(loadCatalog).toHaveBeenNthCalledWith(2, true);
    expect(getStatusEl(container)).toBe(statusEl);
    expect(statusEl.textContent).toBe(EMPTY_TEXT);
    expect(getCatalogEl(container).getAttribute('aria-busy')).toBe('false');
    expect(within(container).getByRole('button', { name: 'Discover' })).toBe(discoverButton);
  });

  it('announces refresh start with existing models and reports the failure outcome', async () => {
    const frames = captureHostFrames();
    const loadCatalog = jest.fn(async (): Promise<'failed'> => 'failed');
    const container = document.body.appendChild(document.createElement('div'));
    const state = populatedState();

    renderProviderModelPicker(buildOptions(container, loadCatalog, () => state));
    await flush(frames);

    const statusEl = getStatusEl(container);
    expect(loadCatalog).not.toHaveBeenCalled();
    expect(statusEl.textContent).toBe('');

    within(container).getByRole('button', { name: 'Refresh' }).click();

    expect(statusEl.textContent).toBe(LOADING_TEXT);
    expect(getCatalogEl(container).getAttribute('aria-busy')).toBe('true');

    await flush(frames);

    expect(loadCatalog).toHaveBeenCalledWith(true);
    expect(getStatusEl(container)).toBe(statusEl);
    expect(statusEl.textContent).toBe(FAILED_TEXT);
    expect(getCatalogEl(container).getAttribute('aria-busy')).toBe('false');
  });

  it('announces the discovered model count once discovery loads a catalog', async () => {
    const frames = captureHostFrames();
    const state = emptyState();
    const loadCatalog = jest.fn(async (): Promise<'loaded'> => {
      Object.assign(state, populatedState());
      return 'loaded';
    });
    const container = document.body.appendChild(document.createElement('div'));

    renderProviderModelPicker(buildOptions(container, loadCatalog, () => state));
    await flush(frames);

    expect(loadCatalog).toHaveBeenCalledWith(false);
    expect(getStatusEl(container).textContent).toBe('Loaded 2 models.');
    expect(within(container).getByRole('button', { name: 'Refresh' })).toBeTruthy();
  });

  it('announces the discovered model count after refreshing existing models', async () => {
    const frames = captureHostFrames();
    const state = populatedState();
    const loadCatalog = jest.fn(async (): Promise<'loaded'> => {
      state.discoveredCount = 1;
      state.models = [{ id: 'model-one', name: 'Model One' }];
      return 'loaded';
    });
    const container = document.body.appendChild(document.createElement('div'));

    renderProviderModelPicker(buildOptions(container, loadCatalog, () => state));
    await flush(frames);

    const statusEl = getStatusEl(container);
    expect(statusEl.textContent).toBe('');

    within(container).getByRole('button', { name: 'Refresh' }).click();

    expect(statusEl.textContent).toBe(LOADING_TEXT);

    await flush(frames);

    expect(loadCatalog).toHaveBeenCalledWith(true);
    expect(getStatusEl(container)).toBe(statusEl);
    expect(statusEl.textContent).toBe('Loaded 1 model.');
  });

  it('schedules the pre-discovery paint on the owner window of a popout document', async () => {
    const hostFrame = jest.spyOn(window, 'requestAnimationFrame');
    const popoutDocument = document.implementation.createHTMLDocument('popout');
    const popoutFrames: FrameRequestCallback[] = [];
    Object.defineProperty(popoutDocument, 'defaultView', {
      configurable: true,
      get: () => ({
        getComputedStyle: window.getComputedStyle.bind(window),
        requestAnimationFrame(callback: FrameRequestCallback): number {
          popoutFrames.push(callback);
          return popoutFrames.length;
        },
      }),
    });

    const loadCatalog = jest.fn(async (): Promise<'loaded'> => 'loaded');
    const container = popoutDocument.body.appendChild(popoutDocument.createElement('div'));
    const state = populatedState();

    renderProviderModelPicker(buildOptions(container, loadCatalog, () => state));
    await settle();

    within(container).getByRole('button', { name: 'Refresh' }).click();

    expect(hostFrame).not.toHaveBeenCalled();
    expect(popoutFrames).toHaveLength(1);
    expect(loadCatalog).not.toHaveBeenCalled();
    expect(getStatusEl(container).textContent).toBe(LOADING_TEXT);

    popoutFrames[0](0);
    await settle();

    expect(hostFrame).not.toHaveBeenCalled();
    expect(loadCatalog).toHaveBeenCalledTimes(1);
    expect(loadCatalog).toHaveBeenCalledWith(true);
    expect(getStatusEl(container).textContent).toBe('Loaded 2 models.');
  });

  it('has no accessibility violations for a settled catalog', async () => {
    const frames = captureHostFrames();
    const loadCatalog = jest.fn(async (): Promise<'loaded'> => 'loaded');
    const container = document.body.appendChild(document.createElement('div'));
    const state = populatedState();

    renderProviderModelPicker(buildOptions(container, loadCatalog, () => state));
    await flush(frames);

    expect(await checkAccessibility(getPickerEl(container))).toHaveNoViolations();
  });
});
