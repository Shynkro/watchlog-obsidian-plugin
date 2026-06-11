/**
 * Generic group-card collage helper.
 *
 * Agnostic to Watch vs Reading: callers pass the group's items plus an accessor
 * that resolves each item's cover/poster URL. This keeps it reusable in the
 * Reading tab (once it gains groups) without importing any Watch-specific types.
 *
 * Selection: walks the items in order and keeps the first up-to-3 with a valid
 * cover (skipping empty / 'none'). The number of strips rendered equals the
 * number of valid covers found (1–3). If none are found, the letter fallback is
 * rendered instead — matching the previous group-card placeholder.
 *
 * Performance: covers are painted as CSS background-images (not <img>), so a
 * cover loading never reflows the card. Combined with the fixed flex layout this
 * avoids layout thrashing inside the virtual-scrolled card grids.
 */
export function renderGroupCollage<T>(
	parent: HTMLElement,
	items: readonly T[],
	getCover: (item: T) => string,
	fallback: { letter: string; color: string },
): HTMLElement {
	const covers: string[] = [];
	for (const item of items) {
		const url = getCover(item);
		if (url && url !== 'none' && url.trim() !== '') {
			covers.push(url);
			if (covers.length === 3) break;
		}
	}

	if (covers.length === 0) {
		const placeholder = parent.createDiv({ cls: 'wl-card-poster-placeholder' });
		placeholder.style.backgroundColor = fallback.color;
		placeholder.createSpan({ text: fallback.letter });
		return placeholder;
	}

	const collage = parent.createDiv({ cls: 'wl-card-collage' });
	for (const url of covers) {
		const strip = collage.createDiv({ cls: 'wl-card-collage-strip' });
		// Escape double quotes so a URL can't break out of the CSS url("...").
		strip.style.backgroundImage = `url("${url.replace(/"/g, '%22')}")`;
	}
	return collage;
}
