---
title: Accounts and roles
description: Accounts, signing in, and what each role may do at each Location.
---

An account is how a person signs in to the management interface. Each account has one role: Admin, Staff or Viewer. This page covers what each role may do, inviting people, changing what someone may do, helping someone who can't sign in, and how a Barista differs from an account.

Admin, Staff, Viewer and Barista are defined in the [Glossary](../../reference/glossary/), with the other words in capitals.

## What each role may do

- An Admin can change everything on the server.
- Staff work at the Locations chosen for them. They see everything except other people's accounts, edit the Library's shared content anywhere, and change the rest only at their Locations.
- A Viewer sees everything Staff see, except Drafts, and changes nothing.

| | Admin | Staff | Viewer |
|---|---|---|---|
| See the Overview, Shots, Steam Records, the Library, Machines and Locations | Yes | Yes | Yes |
| See and work on Drafts | Yes | Yes, publishing only to their Locations | No |
| Edit Beans, Bean Batches, Profiles, Baskets and Tools | Yes | Yes | No |
| Manage Recipes and Grinders, add Bean Batches, and change what a Location offers | Yes | At their Locations | No |
| Rate a Shot or edit its note | Yes | Shots at their Locations | No |
| Move a Machine to another Location | Yes | Between their Locations | No |
| Change a Machine's settings | Yes | The settings open to Staff, at their Locations | No |
| Reload the Skin on a Machine's Tablet | Yes | At their Locations | No |
| Install, update or remove what a Tablet runs | Yes | No | No |
| Add a Machine, issue its Token, or turn its sharing on or off | Yes | No | No |
| Add or edit a Location | Yes | No | No |
| Delete something for good | Yes | No | No |
| Invite people and manage accounts | Yes | No | No |
| Connect an assistant | Yes | Yes | To read only |

A role is for the whole server, and only Staff are tied to Locations.

An assistant someone connects acts as their account, so the same limits hold for it. See [Assistants](../../guide/assistants/).

## Sign in

The first person to open the management interface creates the first Admin account. Setup then closes, and everyone else joins by an invite.

- You sign in with your email and password.
- A browser stays signed in until you choose **Sign out**, in the menu under your name, or until it goes 30 days unused.
- After 5 failed sign-ins for an email within 15 minutes, the server refuses that email until the 15 minutes are up, even with the right password.
- A Viewer sees **Viewer** beside their name, as a reminder that they change nothing.

There is no page for changing your own password. If you forget it, or want another, ask an Admin to [reset it](#help-someone-who-cant-sign-in).

## Invite someone

Only an Admin invites people. The server sends no email, so you send the invite's link yourself.

1. Open **Accounts**.
2. Under **Invite someone**, enter the person's **Email**. It is the email they will sign in with.
3. Choose their **Role**: **Staff**, **Admin** or **Viewer**.
4. For Staff, tick the **Locations they work at**, at least one. Add a Location first if there are none.
5. Choose **Create invite**.
6. Copy the **Invite link** and send it to them, then choose **Done**. The link is shown only this once.

Opening the link, they choose a name and a password of at least 12 characters, and are signed in.

- The link works once, for 7 days. If it is lost or runs out, create another invite.
- An invite not yet used is listed under **Invites**, with when it expires. **Revoke** stops its link working.

## Change what someone may do

1. Open **Accounts**, and choose **Edit role** beside the account.
2. Choose the **Role**, and for Staff the **Locations they work at**.
3. Choose **Save**.

The change applies from their next request, on every device they are signed in on, and to the assistants they connected. The last active Admin stays an Admin: to change their role, make another account an Admin first.

## Help someone who can't sign in

1. Open **Accounts**, and choose **Reset password** beside the account.
2. Copy the **Password reset link** and send it to them, then choose **Done**. The link is shown only this once.

Opening the link, they choose a new password and are signed in, and their other sessions end. The link works once, for a day. Resetting the password again replaces the link.

## Remove someone's access

Accounts are deactivated, never deleted, so what each person changed stays recorded as theirs.

1. Open **Accounts**, and choose **Deactivate** beside the account.
2. Confirm with **Deactivate**.

They are signed out everywhere, their Connected Apps are disconnected, and they can no longer sign in. The last active Admin can't be deactivated. **Reactivate** lets them sign in again with the same password and role. Their Connected Apps stay disconnected, so they connect each again from the app.

To stop only an assistant, disconnect it under **Connected Apps** on the same page. See [See and disconnect your apps](../../guide/assistants/#see-and-disconnect-your-apps).

## Where a Barista differs from an account

A Barista is the person who pulled a Shot, as named on the Tablet. It is a name on a Shot, not a way to sign in.

| | Account | Barista |
|---|---|---|
| What it is | A person who signs in to the management interface | The name on the Tablet when a Shot is pulled |
| Where it is set | By an Admin, on **Accounts** | On the Tablet, as part of the Machine's Workflow |
| What it needs | An invite, an email and a password | Nothing: a Barista needs no account |
| What it does | Decides what the person may see and change | Says who pulled each Shot |
| Where you see it | **Accounts**, and beside each change in an item's history | The **Barista** column and filter of the Shots list, and each Shot's page |

- Nothing links a Barista to an account. Someone with an account who also pulls Shots is named on the Tablet like anyone else.
- Names that differ only in case, or in the spaces around them, are one Barista.
- Staff are the people with an account who work at a Location. Many baristas never need one.
