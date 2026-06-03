"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CardsModule = void 0;
const common_1 = require("@nestjs/common");
const cards_service_1 = require("./cards.service");
const cards_controller_1 = require("./cards.controller");
const prisma_module_1 = require("../prisma/prisma.module");
const pokemon_tcg_module_1 = require("../pokemon-tcg/pokemon-tcg.module");
const scryfall_module_1 = require("../scryfall/scryfall.module");
const ygoprodeck_module_1 = require("../ygoprodeck/ygoprodeck.module");
let CardsModule = class CardsModule {
};
exports.CardsModule = CardsModule;
exports.CardsModule = CardsModule = __decorate([
    (0, common_1.Module)({
        imports: [prisma_module_1.PrismaModule, pokemon_tcg_module_1.PokemonTcgModule, scryfall_module_1.ScryfallModule, ygoprodeck_module_1.YgoprodeckModule],
        controllers: [cards_controller_1.CardsController],
        providers: [cards_service_1.CardsService],
        exports: [cards_service_1.CardsService],
    })
], CardsModule);
//# sourceMappingURL=cards.module.js.map