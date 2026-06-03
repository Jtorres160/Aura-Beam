"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CardsController = void 0;
const common_1 = require("@nestjs/common");
const cards_service_1 = require("./cards.service");
const swagger_1 = require("@nestjs/swagger");
let CardsController = class CardsController {
    constructor(cardsService) {
        this.cardsService = cardsService;
    }
    async findAll(game, q) {
        const cards = await this.cardsService.findAll(game, q);
        return {
            success: true,
            data: cards,
        };
    }
    async findOne(id) {
        const card = await this.cardsService.findOne(id);
        return {
            success: true,
            data: card,
        };
    }
};
exports.CardsController = CardsController;
__decorate([
    (0, common_1.Get)(),
    (0, swagger_1.ApiOperation)({ summary: "Get all cards, optionally filtered by game or search query" }),
    (0, swagger_1.ApiQuery)({ name: "game", required: false, enum: ["POKEMON", "MTG", "YUGIOH"], description: "Game type filter" }),
    (0, swagger_1.ApiQuery)({ name: "q", required: false, description: "Search query for card name or set" }),
    (0, swagger_1.ApiResponse)({ status: 200, description: "Successfully fetched cards" }),
    __param(0, (0, common_1.Query)("game")),
    __param(1, (0, common_1.Query)("q")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, String]),
    __metadata("design:returntype", Promise)
], CardsController.prototype, "findAll", null);
__decorate([
    (0, common_1.Get)(":id"),
    (0, swagger_1.ApiOperation)({ summary: "Get card details by ID" }),
    (0, swagger_1.ApiResponse)({ status: 200, description: "Card details successfully fetched" }),
    (0, swagger_1.ApiResponse)({ status: 404, description: "Card not found" }),
    __param(0, (0, common_1.Param)("id")),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], CardsController.prototype, "findOne", null);
exports.CardsController = CardsController = __decorate([
    (0, swagger_1.ApiTags)("Cards"),
    (0, common_1.Controller)("cards"),
    __metadata("design:paramtypes", [cards_service_1.CardsService])
], CardsController);
//# sourceMappingURL=cards.controller.js.map