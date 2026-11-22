<script lang="ts">
  import { secureHttpsLink, type Attachment, type Conversation, type Label, type ThreadUpdate } from '@kofra/mail-core';
  import { Archive, ArrowLeft, Download, Forward, HardDrive, Inbox, OctagonAlert, Paperclip, Reply, Tag, Trash2 } from '@lucide/svelte';

  let { thread, labels, onBack, onUpdate, onDownload, onSaveToDrive, onCompose }: {
    thread: Conversation; labels: Label[]; onBack: () => void;
    onUpdate: (update: ThreadUpdate) => void; onDownload: (file: Attachment) => void;
    onSaveToDrive: (file: Attachment) => void;
    onCompose: (mode: 'reply' | 'forward', message: Conversation['messages'][number]) => void;
  } = $props();
  let showLabels = $state(false);
  const date = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' });
</script>

<section aria-label="Conversation" class="conversation">
  <div class="toolbar">
    <button class="icon" aria-label="Back to list" onclick={onBack}><ArrowLeft size={20} /></button>
    {#if thread.mailboxId === 'spam' || thread.mailboxId === 'trash'}
      <button class="icon" aria-label="Move to Inbox" onclick={() => onUpdate({ mailboxId: 'inbox' })}><Inbox size={20} /></button>
    {:else}
      {#if thread.mailboxId === 'archive'}<button class="icon" aria-label="Move to Inbox" onclick={() => onUpdate({ mailboxId: 'inbox' })}><Inbox size={20} /></button>
      {:else}<button class="icon" aria-label="Archive" onclick={() => onUpdate({ mailboxId: 'archive' })}><Archive size={20} /></button>{/if}
      <button class="icon" aria-label="Delete" onclick={() => onUpdate({ mailboxId: 'trash' })}><Trash2 size={20} /></button>
      <button class="icon" aria-label="Report spam" onclick={() => onUpdate({ mailboxId: 'spam' })}><OctagonAlert size={20} /></button>
    {/if}
    <button class="icon" aria-label="Manage labels" aria-expanded={showLabels} onclick={() => showLabels = !showLabels}><Tag size={20} /></button>
  </div>
  {#if showLabels}
    <div class="labels-panel">
      {#each labels as label (label.id)}
        <label><input type="checkbox" checked={thread.labelIds.includes(label.id)} onchange={(event) => onUpdate({ labelId: label.id, labelled: event.currentTarget.checked })} /> {label.name}</label>
      {/each}
    </div>
  {/if}
  <div class="thread-body">
    <div class="thread-title"><h1 tabindex="-1" data-view-heading>{thread.subject}</h1>{#each labels.filter((label) => thread.labelIds.includes(label.id)) as label (label.id)}<span class="label-chip"><i></i>{label.name}</span>{/each}</div>
    {#if thread.mailboxId === 'spam'}
      <div class="notice warning"><OctagonAlert size={20} /><div><strong>Why is this message in Spam?</strong><p>It resembles messages identified as spam. Don’t open links or attachments unless you trust the sender.</p></div><button class="pill" onclick={() => onUpdate({ mailboxId: 'inbox' })}>Not spam</button></div>
    {/if}
    {#each thread.messages as message, i (message.id)}
      <details class="message" open={i === thread.messages.length - 1}>
        <summary class="message-head">
          <span class="avatar large" aria-hidden="true">{message.from.name.split(' ').slice(0, 2).map((word) => word[0]).join('')}</span>
          <span class="message-address"><strong>{message.from.name}</strong> <span class="muted address">&lt;{message.from.email}&gt;</span><span class="muted to">to {message.to.map((address) => address.name).join(', ')}</span></span>
          <time datetime={message.date}>{date.format(new Date(message.date))}</time>
        </summary>
        <div class="message-body">
          {#if message.remoteImages}<div class="notice"><span>Remote images blocked</span></div>{/if}
          <p class="plain-message">{message.text}</p>
          {#if message.attachments.length}
            <ul class="files" aria-label="Attachments">
              {#each message.attachments as file (file.id)}
                <li><Paperclip size={20} /><span><strong>{file.name}</strong><small>{file.size.toLocaleString()} bytes</small></span>
                  {#if file.link !== undefined}
                    {@const url = secureHttpsLink(file.link)}
                    {#if url}<a class="icon" href={url} target="_blank" rel="noopener noreferrer" aria-label={`Open Drive link for ${file.name}`}><HardDrive size={18} /></a>
                    {:else}<small>Link unavailable</small>{/if}
                  {:else}
                    <button class="icon" aria-label={`Download ${file.name}`} onclick={() => onDownload(file)}><Download size={18} /></button>
                    <button class="icon" aria-label={`Save ${file.name} to Drive`} onclick={() => onSaveToDrive(file)}><HardDrive size={18} /></button>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
          {#if thread.mailboxId !== 'spam' && thread.mailboxId !== 'trash'}
            <div class="reply-actions"><button class="pill" onclick={() => onCompose('reply', message)}><Reply size={17} /> Reply</button><button class="pill" onclick={() => onCompose('forward', message)}><Forward size={17} /> Forward</button></div>
          {/if}
        </div>
      </details>
    {/each}
  </div>
</section>
