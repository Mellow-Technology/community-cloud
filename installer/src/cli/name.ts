/**
 * @file
 * What the installer is called on the command line.
 *
 * Its own module so that anything printing a command for someone to
 * type — the doctor's suggested fixes — says the same name the CLI
 * answers to, without importing the CLI itself.
 */
export const COMMAND_NAME = "community-cloud";
