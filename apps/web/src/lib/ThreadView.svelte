<script lang="ts">
  import type { Conversation, Label, MailService, MessageAttachment, ThreadChange, View } from '@kofra/mail-contract';
  import Archive from '@lucide/svelte/icons/archive';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import Download from '@lucide/svelte/icons/download';
  import Forward from '@lucide/svelte/icons/forward';
  import HardDrive from '@lucide/svelte/icons/hard-drive';
  import Inbox from '@lucide/svelte/icons/inbox';
  import OctagonAlert from '@lucide/svelte/icons/octagon-exclamation-point';
  import Paperclip from '@lucide/svelte/icons/paperclip';
  import Reply from '@lucide/svelte/icons/reply';
  import Tag from '@lucide/svelte/icons/tag';
  import Trash2 from '@lucide/svelte/icons/trash';

  import { SvelteMap } from 'svelte/reactivity';
  import MessageContent from './MessageContent.svelte';

  let { conversation, view, labels, api, contentOrigin, drive, onBack, onUpdate, onDownload, onSaveToDrive, onCompose }: {
    api: MailService; contentOrigin?: string; drive: boolean;
    conversation: Conversation; view: View; labels: Label[]; onBack: () => void;
    onUpdate: (update: ThreadChange) => void; onDownload: (messageId: string, file: MessageAttachment) => void;
    onSaveToDrive: (messageId: string, file: MessageAttachment) => void;
    onCompose: (mode: 'reply' | 'forward', message: Conversation['messages'][number]) => void;
  } = $props();
  const thread = $derived(conversation.thread);
  let showLabels = $state(false);
  const expanded = new SvelteMap<string, boolean>();
  const restore = $derived(view === 'trash' || view === 'spam' || (!thread.folders.includes('inbox') && thread.folders.includes('archive')));
  const date = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });
</script>

<section aria-label="Conversation" class="conversation">
  <div class="toolbar">
    <button class="icon" aria-label="Back to list" onclick={onBack}><ArrowLeft size={20} /></button>
    {#if restore}<button class="icon" aria-label="Move to Inbox" onclick={() => onUpdate({ folder: 'inbox' })}><Inbox size={20} /></button>
    {:else}<button class="icon" aria-label="Archive" onclick={() => onUpdate({ folder: 'archive' })}><Archive size={20} /></button>{/if}
    {#if view !== 'trash' && view !== 'spam'}
      <button class="icon" aria-label="Delete" onclick={() => onUpdate({ folder: 'trash' })}><Trash2 size={20} /></button>
      <button class="icon" aria-label="Report spam" onclick={() => onUpdate({ folder: 'spam' })}><OctagonAlert size={20} /></button>
    {/if}
    <button class="icon" aria-label="Manage labels" aria-expanded={showLabels} onclick={() => showLabels = !showLabels}><Tag size={20} /></button>
  </div>
  {#if showLabels}
    <div class="labels-panel">
      {#each labels as label (label.id)}
        <label><input type="checkbox" checked={thread.labelIds.includes(label.id)} onchange={(event) => onUpdate(event.currentTarget.checked ? { addLabelIds: [label.id] } : { removeLabelIds: [label.id] })} /> {label.name}</label>
      {/each}
    </div>
  {/if}
  <div class="thread-body">
    <div class="thread-title"><h1 tabindex="-1" data-view-heading>{thread.subject}</h1>{#each labels.filter((label) => thread.labelIds.includes(label.id)) as label (label.id)}<span class="label-chip"><i></i>{label.name}</span>{/each}</div>
    {#if view === 'spam' || thread.folders.includes('spam')}
      <div class="notice warning"><OctagonAlert size={20} /><div><strong>Why is this message in Spam?</strong><p>It resembles messages identified as spam. Don’t open links or attachments unless you trust the sender.</p></div><button class="pill" onclick={() => onUpdate({ folder: 'inbox' })}>Not spam</button></div>
    {/if}
    {#each conversation.messages as message, i (message.id)}
      {@const open = expanded.get(message.id) ?? i === conversation.messages.length - 1}
      {@const unsafeFolder = message.folder === 'spam' || message.folder === 'trash'}
      <details class="message" {open} ontoggle={(event) => expanded.set(message.id, event.currentTarget.open)}>
        <summary class="message-head">
          <span class="avatar large" aria-hidden="true">{message.from.name.split(' ').slice(0, 2).map((word) => word[0]).join('')}</span>
          <span class="message-address"><strong>{message.from.name}</strong> <span class="muted address">&lt;{message.from.email}&gt;</span><span class="muted to">{#if message.to.length}To {message.to.map((address) => address.email).join(', ')}{/if}{#if message.cc?.length}<span class="to">Cc {message.cc.map((address) => address.email).join(', ')}</span>{/if}{#if message.bcc?.length}<span class="to">Bcc {message.bcc.map((address) => address.email).join(', ')}</span>{/if}</span></span>
          <time datetime={message.date}>{date.format(new Date(message.date))}</time>
        </summary>
        <div class="message-body">
          {#if message.verdict.level === 'phishing'}<p class="notice warning"><OctagonAlert size={20} />This message may be phishing. Do not follow links or share personal information.</p>{/if}
          {#if open}<MessageContent {message} {api} origin={unsafeFolder ? undefined : contentOrigin} />{/if}
          {#if message.attachments.length}
            <ul class="files" aria-label="Attachments">
              {#each message.attachments as file (file.part)}
                <li><Paperclip size={20} /><span><strong>{file.name}</strong><small>{file.size.toLocaleString()} bytes</small></span>
                  <button class="icon" aria-label={`Download ${file.name}`} onclick={() => onDownload(message.id, file)}><Download size={18} /></button>
                  <button class="icon" aria-label={`Save ${file.name} to Drive`} disabled={!drive} onclick={() => onSaveToDrive(message.id, file)}><HardDrive size={18} /></button>
                </li>
              {/each}
            </ul>
          {/if}
          {#if !unsafeFolder}
            <div class="reply-actions"><button class="pill" onclick={() => onCompose('reply', message)}><Reply size={17} /> Reply</button><button class="pill" onclick={() => onCompose('forward', message)}><Forward size={17} /> Forward</button></div>
          {/if}
        </div>
      </details>
    {/each}
  </div>
</section>
