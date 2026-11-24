<script lang="ts">
  import { ImageOff } from '@lucide/svelte';
  import { onDestroy, untrack } from 'svelte';
  import type { MailService, Message } from '@kofra/mail-contract';
  import { contentFrameUrl } from './content-origin';

  let { message, api, origin }: { message: Message; api: MailService; origin?: string } = $props();
  let src = $state<string>();
  let images = $state(false);
  let pending = $state(false);
  let unavailable = $state(false);
  // A metadata refresh can replace the whole message object without changing eligibility.
  const formatted = $derived(message.hasHtml);
  const allowedOrigin = $derived(formatted || message.textTruncated ? origin : undefined);
  const frameSrc = $derived(contentFrameUrl(src, allowedOrigin));
  let revision = 0;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  function cancel() { revision++; clearTimeout(expiry); }
  onDestroy(cancel);
  $effect(() => {
    if (allowedOrigin && formatted) untrack(() => { void load(false); });
    else {
      cancel();
      src = undefined;
      images = false;
      pending = false;
      unavailable = false;
    }
  });

  async function load(showImages: boolean) {
    cancel();
    const current = revision;
    // Remove the previous frame before changing its image permission.
    src = undefined;
    images = false;
    pending = true;
    unavailable = false;
    try {
      const link = await api.getBodyUrl(message.id, { remoteImages: showImages });
      if (current !== revision) return;
      const url = contentFrameUrl(link.url, allowedOrigin);
      const remaining = Date.parse(link.expiresAt) - Date.now();
      if (!url || !(remaining > 0)) { unavailable = true; return; }
      src = url;
      images = showImages;
      expiry = setTimeout(() => { void load(showImages); }, Math.min(remaining, 2_147_483_647));
    } catch {
      if (current === revision) unavailable = true;
    } finally {
      if (current === revision) pending = false;
    }
  }
</script>

{#if message.remoteImages}
  <div class="notice image-notice"><ImageOff size={18} /><span>{images ? 'Remote images shown for this message' : 'Remote images blocked'}</span>
    {#if allowedOrigin && (frameSrc || pending)}
      <button class="pill" disabled={pending} onclick={() => load(!images)}>{images ? 'Hide images' : 'Show images'}</button>
    {/if}
  </div>
{/if}
{#if unavailable}<p class="muted" role="status">{message.hasHtml ? 'Formatted message unavailable. Showing plain text.' : 'The full message is unavailable. Showing the preview.'}</p>{/if}
{#snippet plainText()}
  <p class="plain-message">{message.text}</p>
  {#if message.textTruncated}<p class="muted">This message preview is truncated.</p>{/if}
{/snippet}
{#if frameSrc}
  <iframe title={`${message.hasHtml ? 'Formatted message' : 'Full message'}: ${message.subject}`} src={frameSrc} sandbox="allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer"></iframe>
  <details class="text-fallback"><summary>{message.textTruncated ? 'View plain text preview' : 'View plain text'}</summary>{@render plainText()}</details>
{:else}
  {@render plainText()}
  {#if message.textTruncated && allowedOrigin}<button class="pill" disabled={pending} onclick={() => load(false)}>Show full message</button>{/if}
{/if}

<style>
  iframe { display: block; width: 100%; min-height: 12rem; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); }
  .image-notice span { flex: 1; }
  .text-fallback { margin-top: 10px; }
  summary { cursor: pointer; color: var(--accent); }
</style>
