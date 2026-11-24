<script module lang="ts">
  import type { Draft, DraftAttachment, DraftInput } from '@kofra/mail-contract';
  export type ComposeDraft = Draft | (Omit<DraftInput, 'attachments'> & { attachments: DraftAttachment[] });
</script>

<script lang="ts">
  import { HardDrive, Paperclip, Trash2, X } from '@lucide/svelte';
  import { onMount } from 'svelte';
  import { isMailApiError, type AddressInput, type Identity, type MailService } from '@kofra/mail-contract';
  import { mailAction } from './mail-action';

  let { initial, identities, api, m3, onClose, onStatus }: {
    initial: ComposeDraft; identities: Identity[]; api: MailService; m3: boolean;
    onClose: () => void; onStatus: (message: string) => void;
  } = $props();
  const addressText = (items: AddressInput[]) => items.map(({ email }) => email).join(', ');
  function start(value: ComposeDraft) {
    return { ...value, toText: addressText(value.to), ccText: addressText(value.cc), bccText: addressText(value.bcc), attachments: [...value.attachments] };
  }
  function startInitial() { return start(initial); }
  let form = $state(startInitial());
  function initiallyShowCc() { return initial.cc.length > 0 || initial.bcc.length > 0; }
  let ccVisible = $state(initiallyShowCc());
  let pending = $state(false);
  let error = $state('');
  let conflict = $state(false);
  let modal: HTMLDialogElement;
  const create = mailAction();
  function addresses(value: string, original: AddressInput[]) {
    if (value === addressText(original)) return original.map((item) => ({ ...item }));
    return value.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean).map((email) => ({ email }));
  }
  onMount(() => { modal.showModal(); });

  function attachmentRef(attachment: DraftAttachment) {
    if (attachment.kind === 'upload') return { kind: attachment.kind, uploadId: attachment.uploadId };
    if (attachment.kind === 'message') return { kind: attachment.kind, messageId: attachment.messageId, part: attachment.part };
    return { kind: attachment.kind, url: attachment.url, name: attachment.name };
  }
  function attachmentKey(file: DraftAttachment) {
    return file.kind === 'upload' ? `upload:${file.uploadId}` : file.kind === 'message' ? `message:${file.messageId}:${file.part}` : `link:${file.url}`;
  }
  function input(): DraftInput {
    return {
      inReplyTo: form.inReplyTo, forwardOf: form.forwardOf, from: form.from, subject: form.subject,
      to: addresses(form.toText, form.to), cc: addresses(form.ccText, form.cc), bcc: addresses(form.bccText, form.bcc), body: form.body,
      attachments: form.attachments.map(attachmentRef),
    };
  }
  function failure(cause: unknown) {
    conflict = isMailApiError(cause, 'revision_mismatch');
    if (conflict) error = 'This draft changed elsewhere. Copy any edits you want to keep before reloading the saved draft.';
    else if (!m3 && form.attachments.length && isMailApiError(cause, 'not_implemented')) error = 'Draft attachments are not available yet. Remove the attachments to save this draft.';
    else error = cause instanceof Error ? cause.message : 'This action did not complete.';
  }
  function finish() { modal.close(); onClose(); }
  async function save() {
    if (pending || conflict) return;
    pending = true; error = '';
    try {
      const body = input();
      if ('id' in form) await api.replaceDraft(form.id, body, { ifMatch: form.revision });
      else await api.createDraft(body, create.options(body));
      onStatus('Draft saved.'); finish();
    } catch (cause) { failure(cause); }
    finally { pending = false; }
  }
  async function reload() {
    if (pending || !('id' in form)) return;
    pending = true;
    try {
      form = start(await api.getDraft(form.id));
      ccVisible = !!form.ccText || !!form.bccText;
      error = ''; conflict = false;
    } catch (cause) { error = cause instanceof Error ? cause.message : 'Could not reload the draft.'; }
    finally { pending = false; }
  }
  async function discard() {
    if (pending || conflict) return;
    pending = true; error = '';
    try {
      if ('id' in form) await api.deleteDraft(form.id, { ifMatch: form.revision });
      onStatus('Draft discarded.'); finish();
    } catch (cause) { failure(cause); }
    finally { pending = false; }
  }
</script>

<dialog class="modal compose" aria-labelledby="compose-title" bind:this={modal} oncancel={(event) => { event.preventDefault(); if (conflict && !pending) finish(); else void save(); }}>
  <form onsubmit={(event) => event.preventDefault()}>
    <header class="compose-head"><h2 id="compose-title">New message</h2><button class="icon" type="button" aria-label={conflict ? 'Close without saving changes' : 'Close and save draft'} disabled={pending} onclick={() => conflict ? finish() : save()}><X size={19} /></button></header>
    <div class="compose-fields">
      <label class="compose-field">From<select disabled={pending} bind:value={form.from}>{#each identities as identity (identity.email)}<option value={identity.email}>{identity.name} &lt;{identity.email}&gt;{identity.sendAs === 'pending' ? ' (pending)' : ''}</option>{/each}</select></label>
      <div class="recipient-row"><label class="compose-field">To<input type="text" inputmode="email" autocomplete="off" disabled={pending} bind:value={form.toText} /></label><button type="button" class="link-button" aria-expanded={ccVisible} onclick={() => ccVisible = !ccVisible}>Cc and Bcc</button></div>
      {#if ccVisible}
        <label class="compose-field">Cc<input type="text" inputmode="email" autocomplete="off" disabled={pending} bind:value={form.ccText} /></label>
        <label class="compose-field">Bcc<input type="text" inputmode="email" autocomplete="off" disabled={pending} bind:value={form.bccText} /></label>
      {/if}
      <label class="compose-field">Subject<input disabled={pending} bind:value={form.subject} /></label>
    </div>
    <textarea aria-label="Message body" class="compose-body" disabled={pending} bind:value={form.body}></textarea>
    {#if form.attachments.length}
      <ul class="compose-files" aria-label="Attached files">
        {#each form.attachments as file, index (`${attachmentKey(file)}:${index}`)}
          <li><Paperclip size={15} /><span>{file.name}{file.kind === 'link' ? ' (Drive link)' : ''}</span><button type="button" class="icon" aria-label={`Remove ${file.name}`} disabled={pending} onclick={() => form.attachments.splice(index, 1)}><X size={16} /></button></li>
        {/each}
      </ul>
    {/if}
    {#if error}<p class="notice warning form-error" role="alert">{error}</p>{/if}
    {#if conflict}<button class="pill" type="button" disabled={pending} onclick={reload}>Reload saved draft</button>{/if}
    <p id="send-availability" class="compose-availability muted">{m3 ? 'Sending is not supported in this version of Mail.' : 'Sending not available yet'}</p>
    <footer class="compose-actions">
      <button class="pill primary" type="button" disabled aria-describedby="send-availability">Send</button>
      <label class="file-picker icon" title="Upload attachments"><Paperclip size={20} /><input type="file" multiple aria-label="Upload attachments" disabled /></label>
      <button class="icon" type="button" aria-label="Attach from Drive" disabled><HardDrive size={20} /></button>
      <span class="toolbar-spacer"></span><button class="pill" type="button" disabled={pending || conflict} onclick={save}>Save draft</button>
      <button class="icon" type="button" aria-label="Discard draft" disabled={pending || conflict} onclick={discard}><Trash2 size={19} /></button>
    </footer>
  </form>
</dialog>
