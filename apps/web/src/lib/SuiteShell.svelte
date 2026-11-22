<script lang="ts">
  import { Grid2X2, HardDrive, Mail, Menu, Settings, UserRound } from '@lucide/svelte';
  import type { Snippet } from 'svelte';

  // Local, controlled adapter until the shared shell has a tagged release.
  let { product, account, search, onMenu, onSettings, settingsAvailable = false }: {
    product: string;
    account: { name: string; email: string; initials: string };
    search: Snippet;
    onMenu: () => void;
    onSettings: () => void;
    settingsAvailable?: boolean;
  } = $props();
  let open = $state<'apps' | 'account' | undefined>();
  let appsButton: HTMLButtonElement;
  let accountButton: HTMLButtonElement;
  function close(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !open) return;
    (open === 'apps' ? appsButton : accountButton).focus();
    open = undefined;
  }
</script>

<svelte:window onkeydown={close} />
<header class="top">
  <button class="icon" aria-label="Toggle mail navigation" onclick={onMenu}><Menu size={20} /></button>
  <span class="brand"><span class="mark" aria-hidden="true">R</span><span class="brand-name"><strong>Riaklo</strong> {product}</span></span>
  {@render search()}
  <div class="top-right">
    {#if settingsAvailable}<button class="icon settings-icon" aria-label="Settings" onclick={onSettings}><Settings size={20} /></button>{/if}
    <button class="icon" aria-label="Suite apps" aria-controls={open === 'apps' ? 'suite-apps' : undefined} aria-expanded={open === 'apps'} bind:this={appsButton} onclick={() => open = open === 'apps' ? undefined : 'apps'}><Grid2X2 size={19} /></button>
    <button class="icon" aria-label={`${account.initials} · Account menu`} aria-controls={open === 'account' ? 'suite-account' : undefined} aria-expanded={open === 'account'} bind:this={accountButton} onclick={() => open = open === 'account' ? undefined : 'account'}><span class="avatar">{account.initials}</span></button>
  </div>
  {#if open === 'apps'}
    <section class="popover" id="suite-apps" aria-label="Suite apps">
      <h2>Apps</h2>
      <ul class="app-grid">
        <li><button class="icon app-tile" onclick={() => { open = undefined; appsButton.focus(); }}><Mail size={22} /> Mail</button></li>
        <li><span class="app-tile"><HardDrive size={22} /> Drive</span></li>
        <li><span class="app-tile"><UserRound size={22} /> Account</span></li>
      </ul>
      <p class="muted">Drive and Account aren’t connected in this demo.</p>
    </section>
  {:else if open === 'account'}
    <section class="popover" id="suite-account" aria-label="Account">
      <h2>{account.name}</h2><p>{account.email}</p><p class="muted">Demo account</p>
      {#if settingsAvailable}<button class="pill" onclick={() => { open = undefined; onSettings(); }}>Mail settings</button>{/if}
    </section>
  {/if}
</header>
