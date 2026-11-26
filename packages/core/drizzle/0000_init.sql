CREATE TABLE `contacts` (
	`id` blob PRIMARY KEY NOT NULL,
	`sealed` blob NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation` blob NOT NULL,
	`uid` blob NOT NULL,
	`sealed` blob NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_uid_unique` ON `messages` (`uid`);--> statement-breakpoint
CREATE INDEX `messages_by_conversation` ON `messages` (`conversation`,`id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`sealed` blob NOT NULL
);
