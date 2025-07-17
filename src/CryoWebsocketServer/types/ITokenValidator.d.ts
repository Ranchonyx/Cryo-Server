export interface ITokenValidator {
	validate(token: string): Promise<boolean>;
}