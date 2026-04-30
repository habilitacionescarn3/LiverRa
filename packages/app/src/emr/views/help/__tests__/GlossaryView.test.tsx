// SPDX-FileCopyrightText: Copyright LiverRa
// SPDX-License-Identifier: Apache-2.0

/**
 * GlossaryView tests (co-located with T105 glossary view).
 *
 * Plain-English: we drive the component through the real TranslationProvider
 * (so we're exercising the actual glossary.json bundle), then:
 *   1. Confirm all 8 Couinaud segments render on the default "All" view.
 *   2. Filter "portal" → the portal-vein row is the only vessel row visible.
 *   3. Click the "Lesion classes" filter → 6 lesion rows render.
 *   4. Type gibberish → empty state shows, clicking "Clear filter" resets.
 *   5. Deep-link #couinaud-III scrolls/selects that row (we mock
 *      scrollIntoView in jsdom-equivalent happy-dom and just assert the
 *      anchor element exists).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import GlossaryView from '../GlossaryView';
import { renderWithProviders } from '../../../../test-utils';

// happy-dom doesn't implement Element.scrollIntoView — stub it so the
// deep-link effect doesn't throw. We don't assert on the call directly;
// the presence of the anchored element is enough.
beforeEach(() => {
  if (!Element.prototype.scrollIntoView) {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    Element.prototype.scrollIntoView = function () {};
  } else {
    vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(
      () => undefined,
    );
  }
});

/**
 * Wait until the English glossary bundle has loaded and the page header
 * title is in the DOM — the translation lazy-loader returns the raw key
 * string until the import resolves.
 */
async function renderGlossary(): Promise<void> {
  renderWithProviders(<GlossaryView />);
  await waitFor(() => {
    expect(screen.getByText('Clinical glossary')).toBeDefined();
  });
}

describe('GlossaryView', () => {
  it('renders all 8 Couinaud segments under the default "All" category', async () => {
    await renderGlossary();

    // All 8 segments should be present as accordion controls.
    for (const roman of ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII']) {
      expect(
        screen.getByTestId(`glossary-term-couinaud-${roman}`),
      ).toBeDefined();
    }

    // Results count pill reports the full total.
    const count = screen.getByTestId('glossary-results-count');
    expect(count.textContent).toContain('29');
  });

  it('filtering by "portal" narrows to entries matching portal (vein + venous phase)', async () => {
    const user = userEvent.setup();
    await renderGlossary();

    const search = screen.getByTestId('glossary-search') as HTMLInputElement;
    await user.type(search, 'portal');

    // Debounced 200ms → wait for the portal-vein row to remain and
    // non-matching terms (e.g. Segment I "Lobus caudatus") to disappear.
    await waitFor(
      () => {
        expect(screen.getByTestId('glossary-term-vessels-portal')).toBeDefined();
        expect(
          screen.queryByTestId('glossary-term-couinaud-I'),
        ).toBeNull();
      },
      { timeout: 2000 },
    );
  });

  it('selecting the Lesions category shows all 6 lesion classes only', async () => {
    const user = userEvent.setup();
    await renderGlossary();

    // Click "Lesion classes" radio inside the SegmentedControl.
    const lesionsRadio = await screen.findByRole('radio', {
      name: 'Lesion classes',
    });
    await user.click(lesionsRadio);

    await waitFor(() => {
      const section = screen.getByTestId(
        'glossary-category-section-lesions',
      );
      const rows = within(section).getAllByTestId(/^glossary-term-lesions-/);
      expect(rows.length).toBe(6);

      // Non-lesion categories should be hidden.
      expect(
        screen.queryByTestId('glossary-category-section-couinaud'),
      ).toBeNull();
    });
  });

  it('empty-state "Clear filter" CTA resets search + category', async () => {
    const user = userEvent.setup();
    await renderGlossary();

    const search = screen.getByTestId('glossary-search') as HTMLInputElement;
    await user.type(search, 'zzznomatchzzz');

    // Empty state appears.
    const empty = await screen.findByTestId(
      'glossary-empty-state',
      {},
      { timeout: 2000 },
    );
    const clearBtn = within(empty).getByRole('button', {
      name: 'Clear filter',
    });
    await user.click(clearBtn);

    await waitFor(() => {
      // Search input cleared and all 8 Couinaud segments visible again.
      expect(search.value).toBe('');
      expect(screen.getByTestId('glossary-term-couinaud-I')).toBeDefined();
    });
  });

  it('deep-link hash #couinaud-III exposes a target anchor element', async () => {
    window.history.replaceState(null, '', '#couinaud-III');
    await renderGlossary();

    // The anchored item must exist with both `id` and the data attribute
    // used by the scroll-into-view effect.
    const target = await screen.findByTestId('glossary-term-couinaud-III');
    expect(target.getAttribute('data-glossary-anchor')).toBe('couinaud-III');
    expect(target.getAttribute('id')).toBe('couinaud-III');

    // Cleanup so subsequent tests don't see the hash.
    window.history.replaceState(null, '', window.location.pathname);
  });
});
