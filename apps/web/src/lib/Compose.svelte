<script module lang="ts">
  import type { Draft, DraftAttachment, DraftAttachmentRef, DraftInput } from '@kofra/mail-contract';
  export type ComposeDraft = Draft | (Omit<DraftInput, 'attachments'> & { attachments: DraftAttachment[] });
  export type DraftEdits = {
    to: string; cc: string; bcc: string; subject: string; body: string; inReplyTo?: string;
    existing?: Pick<Draft, 'id' | 'revision'>;
  };
</script>

<script lang="ts">
  import HardDrive from '@lucide/svelte/icons/hard-drive';
  import Paperclip from '@lucide/svelte/icons/paperclip';
  import Trash2 from '@lucide/svelte/icons/trash';
  import X from '@lucide/svelte/icons/x';
  import { onMount } from 'svelte';
  import { attachmentBudget, isMailApiError, LIMITS, type AddressInput, type Identity, type Limits, type MailService } from '@kofra/mail-contract';
  import { mailAction } from './mail-action';

  let { initial, restoredEdits, identities, api, m3, fileLinks = false, limits = LIMITS, onClose, onStatus }: {
    initial: ComposeDraft; restoredEdits?: DraftEdits; identities: Identity[]; api: MailService; m3: boolean; fileLinks?: boolean; limits?: Limits;
    onClose: () => void; onStatus: (message: string) => void;
  } = $props();
  const addressText = (items: AddressInput[]) => items.map(({ email }) => email).join(', ');
  function start(value: ComposeDraft) {
    return { ...value, toText: addressText(value.to), ccText: addressText(value.cc), bccText: addressText(value.bcc), attachments: [...value.attachments] };
  }
  function startInitial() {
    const next = start(initial);
    if (restoredEdits) {
      next.toText = restoredEdits.to;
      next.ccText = restoredEdits.cc;
      next.bccText = restoredEdits.bcc;
      next.subject = restoredEdits.subject;
      next.body = restoredEdits.body;
      next.inReplyTo = restoredEdits.inReplyTo;
    }
    return next;
  }
  let form = $state(startInitial());
  export function snapshotEdits(): DraftEdits {
    return {
      to: form.toText, cc: form.ccText, bcc: form.bccText, subject: form.subject, body: form.body, inReplyTo: form.inReplyTo,
      existing: 'id' in form ? { id: form.id, revision: form.revision } : undefined,
    };
  }
  function initiallyShowCc() {
    return restoredEdits ? Boolean(restoredEdits.cc || restoredEdits.bcc) : initial.cc.length > 0 || initial.bcc.length > 0;
  }
  let ccVisible = $state(initiallyShowCc());
  let pending = $state(false);
  let error = $state('');
  let conflict = $state(false);
  let modal: HTMLDialogElement;
  const create = mailAction();
  let customExpiry = $state<Record<string, boolean>>({});
  function expiryChoice(file: Extract<DraftAttachment, { kind: 'file_link' }>) {
    return customExpiry[file.linkUploadId] || (typeof file.expiry === 'number' && ![7, 30, 90].includes(file.expiry)) ? 'custom' : String(file.expiry);
  }
  function chooseExpiry(file: Extract<DraftAttachment, { kind: 'file_link' }>, value: string) {
    customExpiry[file.linkUploadId] = value === 'custom';
    file.expiry = value === 'never' ? 'never' : value === 'custom' ? (typeof file.expiry === 'number' ? file.expiry : 30) : Number(value);
  }
  async function addFiles(event: Event) {
    const picker = event.currentTarget as HTMLInputElement;
    const selected = [...(picker.files ?? [])];
    picker.value = '';
    if (pending || !fileLinks || !selected.length) return;
    pending = true; error = '';
    try {
      for (const file of selected) {
        const inline = form.attachments.filter(file => file.kind === 'upload' || file.kind === 'message');
        const remaining = attachmentBudget(limits, form.body) - inline.reduce((n, file) => n + file.size, 0);
        if (inline.length < limits.attachmentsPerMessage && file.size <= remaining) {
          const upload = await api.createUpload({ name: file.name, type: file.type || 'application/octet-stream', bytes: file }, { idempotencyKey: crypto.randomUUID() });
          form.attachments.push({ kind: 'upload', uploadId: upload.id, name: upload.name, type: upload.type, size: upload.size });
        } else {
          if (form.attachments.filter(item => item.kind === 'file_link').length >= limits.fileLinksPerMessage) throw new Error('Too many download links on this draft.');
          const upload = await api.createLinkUpload({ name: file.name, size: file.size }, { idempotencyKey: crypto.randomUUID() });
          try {
            for (let i = 0; i < upload.parts; i++) {
              await api.putLinkPart(upload.id, i + 1, { bytes: file.slice(i * upload.partSize, (i + 1) * upload.partSize) });
            }
            const complete = await api.completeLinkUpload(upload.id);
            form.attachments.push({ kind: 'file_link', linkUploadId: complete.id, name: complete.name, size: complete.size, expiry: limits.linkExpiryDefaultDays });
          } catch (cause) {
            void api.deleteLinkUpload(upload.id).catch(() => {});
            throw cause;
          }
        }
      }
    } catch (cause) { failure(cause); }
    finally { pending = false; }
  }
  function addresses(value: string, original: AddressInput[]) {
    if (value === addressText(original)) return original.map((item) => ({ ...item }));
    return value.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean).map((email) => ({ email }));
  }
  onMount(() => { modal.showModal(); });

  function attachmentRef(attachment: DraftAttachment): DraftAttachmentRef {
    if (attachment.kind === 'upload') return { kind: attachment.kind, uploadId: attachment.uploadId };
    if (attachment.kind === 'message') return { kind: attachment.kind, messageId: attachment.messageId, part: attachment.part };
    // A file link keeps its upload and expiry choice when the draft is saved again.
    if (attachment.kind === 'file_link') return { kind: attachment.kind, linkUploadId: attachment.linkUploadId, expiry: attachment.expiry };
    return { kind: attachment.kind, url: attachment.url, name: attachment.name };
  }
  function attachmentKey(file: DraftAttachment) {
    if (file.kind === 'file_link') return `file_link:${file.linkUploadId}`;
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
    else if (isMailApiError(cause) && (cause.status === 401 || cause.status === 403)) {
      error = 'Your draft is still open. Try again when your mail session is ready.';
    } else if (!m3 && form.attachments.length && isMailApiError(cause, 'not_implemented')) error = 'Draft attachments are not available yet. Remove the attachments to save this draft.';
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
    {#if form.attachments.some(file => file.kind === 'file_link')}
      <p class="notice" role="status">Files that do not fit are shared as download links.</p>
    {/if}
    {#if form.attachments.length}
      <ul class="compose-files" aria-label="Attached files">
        {#each form.attachments as file, index (`${attachmentKey(file)}:${index}`)}
          <li>
            <Paperclip size={15} /><span>{file.name}{file.kind === 'link' ? ' (Drive link)' : file.kind === 'file_link' ? ' (download link)' : ''}</span>
            {#if file.kind === 'file_link' && fileLinks}
              <select aria-label={`Expiry for ${file.name}`} value={expiryChoice(file)} disabled={pending} onchange={(event) => chooseExpiry(file, event.currentTarget.value)}>
                <option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days</option>
                <option value="never">Never</option><option value="custom">Custom</option>
              </select>
              {#if expiryChoice(file) === 'custom'}
                <input aria-label={`Expiry days for ${file.name}`} type="number" min="1" max={limits.linkExpiryMaxDays} step="1" disabled={pending}
                  value={file.expiry} onchange={(event) => {
                    const days = event.currentTarget.valueAsNumber;
                    if (Number.isInteger(days) && days >= 1 && days <= limits.linkExpiryMaxDays) file.expiry = days;
                    else event.currentTarget.value = String(file.expiry);
                  }} />
              {/if}
            {/if}
            <button type="button" class="icon" aria-label={`Remove ${file.name}`} disabled={pending} onclick={() => form.attachments.splice(index, 1)}><X size={16} /></button>
          </li>
        {/each}
      </ul>
    {/if}
    {#if error}<p class="notice warning form-error" role="alert">{error}</p>{/if}
    {#if conflict}<button class="pill" type="button" disabled={pending} onclick={reload}>Reload saved draft</button>{/if}
    <p id="send-availability" class="compose-availability muted">{m3 ? 'Sending is not supported in this version of Mail.' : 'Sending not available yet'}</p>
    <footer class="compose-actions">
      <button class="pill primary" type="button" disabled aria-describedby="send-availability">Send</button>
      <label class="file-picker icon" title="Upload attachments"><Paperclip size={20} /><input type="file" multiple aria-label="Upload attachments" disabled={pending || !fileLinks} onchange={addFiles} /></label>
      <button class="icon" type="button" aria-label="Attach from Drive" disabled><HardDrive size={20} /></button>
      <span class="toolbar-spacer"></span><button class="pill" type="button" disabled={pending || conflict} onclick={save}>Save draft</button>
      <button class="icon" type="button" aria-label="Discard draft" disabled={pending || conflict} onclick={discard}><Trash2 size={19} /></button>
    </footer>
  </form>
</dialog>
