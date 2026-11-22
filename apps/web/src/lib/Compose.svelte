<script lang="ts">
  import { HardDrive, Paperclip, Trash2, X } from '@lucide/svelte';
  import { onMount } from 'svelte';
  import type { Attachment, Draft, DriveFile, Identity, MailApi, PendingSend } from '@kofra/mail-core';

  let { initial, identities, api, onClose, onSent, onStatus }: {
    initial: Draft; identities: Identity[]; api: MailApi; onClose: () => void;
    onSent: (sent: PendingSend) => void; onStatus: (message: string) => void;
  } = $props();
  function start() {
    return { ...initial, toText: initial.to.join(', '), ccText: initial.cc.join(', '), bccText: initial.bcc.join(', '), attachments: [...initial.attachments] };
  }
  let form = $state(start());
  let ccVisible = $state(!!form.ccText || !!form.bccText);
  let pending = $state(false);
  let error = $state('');
  let driveError = $state('');
  let driveItems = $state<DriveFile[]>([]);
  let selected = $state('');
  let modal: HTMLDialogElement;
  let picker: HTMLDialogElement;
  const addresses = (value: string) => value.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);
  onMount(() => { modal.showModal(); });

  function draft(): Draft {
    return {
      id: form.id, replyToThreadId: form.replyToThreadId, from: form.from, subject: form.subject,
      to: addresses(form.toText), cc: addresses(form.ccText), bcc: addresses(form.bccText), body: form.body,
      attachments: form.attachments.map((attachment) => ({ ...attachment }))
    };
  }
  function errorMessage(cause: unknown) { return cause instanceof Error ? cause.message : 'This action did not complete.'; }
  function finish() { modal.close(); onClose(); }
  async function save() {
    if (pending) return;
    pending = true; error = '';
    try { await api.saveDraft(draft()); onStatus('Draft saved.'); finish(); }
    catch (cause) { error = errorMessage(cause); }
    finally { pending = false; }
  }
  async function discard() {
    if (pending) return;
    pending = true; error = '';
    try { if (form.id) await api.discardDraft(form.id); onStatus('Draft discarded.'); finish(); }
    catch (cause) { error = errorMessage(cause); }
    finally { pending = false; }
  }
  async function send(event: SubmitEvent) {
    event.preventDefault();
    if (pending) return;
    pending = true; error = '';
    try { onSent(await api.send(draft())); finish(); }
    catch (cause) { error = errorMessage(cause); }
    finally { pending = false; }
  }
  function attach(files: Attachment[]) {
    if ([...form.attachments, ...files].reduce((total, file) => total + file.size, 0) > 25 * 1024 * 1024) throw new Error('Attachments cannot exceed 25 MiB in total.');
    form.attachments.push(...files);
  }
  async function upload(event: Event & { currentTarget: HTMLInputElement }) {
    const input = event.currentTarget;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (!files.length || pending) return;
    pending = true; error = '';
    try {
      if ([...form.attachments, ...files].reduce((sum, item) => sum + item.size, 0) > 25 * 1024 * 1024) throw new Error('Attachments cannot exceed 25 MiB in total.');
      attach(await Promise.all(files.map((file) => api.uploadAttachment(file, file.name))));
    } catch (cause) { error = errorMessage(cause); }
    finally { pending = false; }
  }
  async function openPicker() {
    if (pending) return;
    pending = true; error = ''; driveError = ''; selected = '';
    try { driveItems = await api.listDriveFiles(); picker.showModal(); }
    catch (cause) { error = errorMessage(cause); }
    finally { pending = false; }
  }
  async function addDrive(mode: 'copy' | 'link') {
    if (!selected || pending) return;
    pending = true; driveError = '';
    try {
      const added = await api.attachFromDrive(selected, mode);
      if (!form.attachments.some((item) => item.id === added.id)) attach([added]);
      picker.close();
    } catch (cause) { driveError = errorMessage(cause); }
    finally { pending = false; }
  }
</script>

<dialog class="modal compose" aria-labelledby="compose-title" bind:this={modal} oncancel={(event) => { event.preventDefault(); void save(); }}>
  <form onsubmit={send}>
    <header class="compose-head"><h2 id="compose-title">New message</h2><button class="icon" type="button" aria-label="Close and save draft" disabled={pending} onclick={save}><X size={19} /></button></header>
    <div class="compose-fields">
      <label class="compose-field">From<select bind:value={form.from}>{#each identities as identity (identity.email)}<option value={identity.email}>{identity.name} &lt;{identity.email}&gt;</option>{/each}</select></label>
      <div class="recipient-row"><label class="compose-field">To<input type="text" inputmode="email" autocomplete="off" bind:value={form.toText} /></label><button type="button" class="link-button" aria-expanded={ccVisible} onclick={() => ccVisible = !ccVisible}>Cc and Bcc</button></div>
      {#if ccVisible}
        <label class="compose-field">Cc<input type="text" inputmode="email" autocomplete="off" bind:value={form.ccText} /></label>
        <label class="compose-field">Bcc<input type="text" inputmode="email" autocomplete="off" bind:value={form.bccText} /></label>
      {/if}
      <label class="compose-field">Subject<input bind:value={form.subject} /></label>
    </div>
    <textarea aria-label="Message body" class="compose-body" bind:value={form.body}></textarea>
    {#if form.attachments.length}
      <ul class="compose-files" aria-label="Attached files">
        {#each form.attachments as file (file.id)}
          <li><Paperclip size={15} /><span>{file.name}{file.link ? ' (Drive link)' : ''}</span><button type="button" class="icon" aria-label={`Remove ${file.name}`} onclick={() => form.attachments = form.attachments.filter((item) => item.id !== file.id)}><X size={16} /></button></li>
        {/each}
      </ul>
    {/if}
    {#if error}<p class="notice warning form-error" role="alert">{error}</p>{/if}
    <footer class="compose-actions">
      <button class="pill primary" disabled={pending}>Send</button>
      <label class="file-picker icon" title="Upload attachments"><Paperclip size={20} /><input type="file" multiple aria-label="Upload attachments" disabled={pending} onchange={upload} /></label>
      <button class="icon" type="button" aria-label="Attach from Drive" disabled={pending} onclick={openPicker}><HardDrive size={20} /></button>
      <span class="toolbar-spacer"></span><button class="pill" type="button" disabled={pending} onclick={save}>Save draft</button>
      <button class="icon" type="button" aria-label="Discard draft" disabled={pending} onclick={discard}><Trash2 size={19} /></button>
    </footer>
  </form>
</dialog>

<dialog class="modal drive-picker" aria-labelledby="drive-title" bind:this={picker}>
  <header class="compose-head"><h2 id="drive-title">Attach from Drive</h2><button type="button" class="icon" aria-label="Close Drive picker" onclick={() => picker.close()}><X size={19} /></button></header>
  <p class="muted">Demo Drive files. Attach a copy or share a link.</p>
  <ul class="drive-files">
    {#each driveItems as file (file.id)}
      <li><label><input type="radio" name="drive-file" value={file.id} bind:group={selected} /><span>{file.name}</span><small>{file.size.toLocaleString()} bytes</small></label></li>
    {:else}<li>No files are available in Drive.</li>{/each}
  </ul>
  {#if driveError}<p class="notice warning" role="alert">{driveError}</p>{/if}
  <div class="dialog-actions"><button type="button" class="pill" disabled={!selected || pending} onclick={() => addDrive('link')}>Insert link</button><button type="button" class="pill primary" disabled={!selected || pending} onclick={() => addDrive('copy')}>Attach copy</button></div>
</dialog>
