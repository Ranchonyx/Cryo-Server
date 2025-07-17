import express from "express";

export interface ISessionIDGenerator {
	generate(req: express.Request): string;
}