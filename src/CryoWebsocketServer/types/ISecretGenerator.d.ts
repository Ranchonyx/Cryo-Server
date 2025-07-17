export interface ISecretGenerator {
	generate(): Promise<string>;
}