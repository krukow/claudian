/** @jest-environment jsdom */

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

import { getByRole } from '@testing-library/dom';

import {
  type ProviderModelPickerOptions,
  renderProviderModelPicker,
} from '@/shared/settings/ProviderModelPicker';

const LOADING_TEXT = 'Loading model catalog...';
const EMPTY_TEXT = 'No models discovered.';

function buildOptions(
  container: HTMLElement,
  loadCatalog: ProviderModelPickerOptions['loadCatalog'],
): ProviderModelPickerOptions {
  return {
    container,
    emptyCatalogText: EMPTY_TEXT,
    failedCatalogText: 'Could not load the model catalog.',
    getState: () => ({
      aliases: {},
      discoveredCount: 0,
      models: [],
      selectedIds: [],
    }),
    initiallyOpen: false,
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
    throw new Error('Picker element was not rendered');
  }
  return pickerEl;
}

async function settle(): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(resolve, 0);
  });
}

beforeAll(() => {
  Object.defineProperties(HTMLElement.prototype, {
    addClass: {
      configurable: true,
      value(this: HTMLElement, ...classes: string[]): void {
        this.classList.add(...classes);
      },
    },
    empty: {
      configurable: true,
      value(this: HTMLElement): void {
        this.replaceChildren();
      },
    },
    toggleClass: {
      configurable: true,
      value(this: HTMLElement, className: string, force: boolean): void {
        this.classList.toggle(className, force);
      },
    },
  });
});

afterEach(() => {
  jest.restoreAllMocks();
  document.body.replaceChildren();
});

// The catalog starts collapsed so that opening it does not schedule its own discovery pass;
// role queries therefore opt into the collapsed subtree with `hidden`.
describe('provider model picker catalog discovery', () => {
  it('announces the loading state before discovery starts and clears it afterwards', async () => {
    const frames: FrameRequestCallback[] = [];
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const loadCatalog = jest.fn(async (): Promise<'empty'> => 'empty');
    const container = document.body.appendChild(document.createElement('div'));

    renderProviderModelPicker(buildOptions(container, loadCatalog));

    const discoverButton = getByRole<HTMLButtonElement>(container, 'button', {
      hidden: true,
      name: 'Discover',
    });
    expect(discoverButton.type).toBe('button');

    discoverButton.click();

    expect(loadCatalog).not.toHaveBeenCalled();
    expect(getByRole(container, 'button', { hidden: true, name: 'Loading...' }))
      .toBe(discoverButton);
    expect(discoverButton.disabled).toBe(true);
    expect(getPickerEl(container).getAttribute('aria-busy')).toBe('true');

    const statusEl = getByRole(container, 'status', { hidden: true });
    expect(statusEl.textContent).toBe(LOADING_TEXT);
    expect(statusEl.getAttribute('aria-live')).toBe('polite');

    const paintFrame = frames.shift();
    if (!paintFrame) {
      throw new Error('Discovery did not yield a frame before loading the catalog');
    }
    paintFrame(0);
    await settle();

    expect(loadCatalog).toHaveBeenCalledTimes(1);
    expect(loadCatalog).toHaveBeenCalledWith(true);
    expect(getByRole(container, 'button', { hidden: true, name: 'Discover' }))
      .toBe(discoverButton);
    expect(discoverButton.disabled).toBe(false);
    expect(getPickerEl(container).getAttribute('aria-busy')).toBe('false');
    expect(container.textContent).toContain(EMPTY_TEXT);
  });

  it('schedules the pre-discovery paint on the owner window of a popout document', async () => {
    const popoutDocument = document.implementation.createHTMLDocument('popout');
    const popoutFrames: FrameRequestCallback[] = [];
    Object.defineProperty(popoutDocument, 'defaultView', {
      configurable: true,
      get: () => ({
        requestAnimationFrame(callback: FrameRequestCallback): number {
          popoutFrames.push(callback);
          return popoutFrames.length;
        },
      }),
    });
    const hostFrame = jest.spyOn(window, 'requestAnimationFrame');
    const loadCatalog = jest.fn(async (): Promise<'empty'> => 'empty');
    const container = popoutDocument.body.appendChild(popoutDocument.createElement('div'));

    renderProviderModelPicker(buildOptions(container, loadCatalog));

    getPickerEl(container)
      .querySelector<HTMLButtonElement>('.claudian-provider-model-picker-action')
      ?.click();

    expect(hostFrame).not.toHaveBeenCalled();
    expect(popoutFrames).toHaveLength(1);
    expect(loadCatalog).not.toHaveBeenCalled();

    popoutFrames[0](0);
    await settle();

    expect(loadCatalog).toHaveBeenCalledTimes(1);
  });
});
